import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAcceptance, tailOf, failureSignature } from "../src/longrun/acceptance";
import { workTreeFingerprint } from "../src/longrun/fingerprint";
import { LONGRUN_MARK, MISSING_TOOL, endsWithQuestion, handlePrompt, handleStop, type HookDeps } from "../src/longrun/hooks";
import { parseAcceptanceLine, resolveProject } from "../src/longrun/project";
import { DEFAULT_LONGRUN_SETTINGS, loadLongrunSettings, normalizeSettings, saveLongrunSettings } from "../src/longrun/settings";
import { loadState, saveState, freshState } from "../src/longrun/state";
import { insideTrustedProject, mayRunProjectCommands, trustedProjects } from "../src/longrun/trust";
import { withWorkerRules } from "../src/longrun/worker";
import type { WorkerLock } from "../src/longrun/worker-lock";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function temp(prefix = "longrun-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

const SESSION = "01a18539-e4df-7061-8f32-2c0fcf5881de";

function fakeDeps(over: Partial<HookDeps> & { fingerprints?: string[]; results?: Array<{ ok: boolean; tail?: string; signature?: string; exitCode?: number | null }> } = {}) {
  const home = over.home ?? temp("longrun-home-");
  const fingerprints = over.fingerprints ?? [];
  const results = over.results ?? [];
  let clock = 1_000_000;
  const calls = { acceptance: 0, log: [] as string[] };
  const deps: HookDeps = {
    home,
    now: () => (clock += 1000),
    settings: () => normalizeSettings({}),
    project: () => ({ enabled: true, root: "C:/p", acceptance: { command: "npm test", source: "package.json" } }),
    fingerprint: () => fingerprints.shift() ?? "fp-same",
    mayRun: () => true,
    acceptance: async () => {
      calls.acceptance += 1;
      const next = results.shift() ?? { ok: true };
      return { ok: next.ok, exitCode: next.exitCode ?? (next.ok ? 0 : 1), timedOut: false, tail: next.tail ?? "", durationMs: 5, signature: next.signature ?? `sig${calls.acceptance}` };
    },
    log: (event) => calls.log.push(event),
    ...over,
  };
  return { deps, calls, home };
}

const stop = (extra: Record<string, unknown> = {}) => ({ session_id: SESSION, cwd: "C:/p", model: "chatgpt-web/gpt-6-sol", last_assistant_message: "Done.", ...extra });
const prompt = (text: string, extra: Record<string, unknown> = {}) => ({ session_id: SESSION, cwd: "C:/p", model: "chatgpt-web/gpt-6-sol", prompt: text, ...extra });

// ---- settings

test("settings are clamped so a bad file cannot make the loop unbounded", () => {
  const settings = normalizeSettings({ maxContinuations: 1e9, maxHours: -4, sameFailureLimit: "x", acceptanceTimeoutMinutes: 9999, modelPrefixes: [] });
  expect(settings.maxContinuations).toBe(500);
  expect(settings.maxHours).toBe(0.25);
  expect(settings.sameFailureLimit).toBe(DEFAULT_LONGRUN_SETTINGS.sameFailureLimit);
  expect(settings.acceptanceTimeoutMinutes).toBe(240);
  expect(settings.modelPrefixes).toEqual(["chatgpt-web/"]);
  expect(normalizeSettings("garbage").enabled).toBe(true);
});

test("settings load from the home folder, can be saved, and an environment switch turns the feature off", () => {
  const home = temp();
  expect(loadLongrunSettings(home, {}).enabled).toBe(true);
  saveLongrunSettings({ enabled: false, maxContinuations: 7 }, home);
  const saved = loadLongrunSettings(home, {});
  expect(saved.enabled).toBe(false);
  expect(saved.maxContinuations).toBe(7);
  saveLongrunSettings({ enabled: true }, home);
  expect(loadLongrunSettings(home, {}).maxContinuations).toBe(7);
  expect(loadLongrunSettings(home, { CODEX_LONGRUN: "off" }).enabled).toBe(false);
  writeFileSync(join(home, "longrun.json"), "{ not json");
  expect(loadLongrunSettings(home, {}).enabled).toBe(true);
});

// ---- project detection

test("an acceptance line in AGENTS.md is understood in common spellings", () => {
  expect(parseAcceptanceLine("# Rules\nacceptance: npm test\n")).toBe("npm test");
  expect(parseAcceptanceLine("- Acceptance command: `pytest -q`")).toBe("pytest -q");
  expect(parseAcceptanceLine("* **Acceptance check**: cargo test --all")).toBe("cargo test --all");
  expect(parseAcceptanceLine("acceptance: none")).toBeUndefined();
  expect(parseAcceptanceLine("The acceptance of this is unclear")).toBeUndefined();
});

test("an explicit command beats detection and the nearest folder wins", () => {
  const root = temp();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  expect(resolveProject(root).acceptance).toMatchObject({ command: "npm test", source: "package.json" });
  writeFileSync(join(root, "AGENTS.md"), "acceptance: node check.js\n");
  expect(resolveProject(root).acceptance).toMatchObject({ command: "node check.js", source: "AGENTS.md" });
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "longrun.json"), JSON.stringify({ acceptance: "make verify", maxContinuations: 3 }));
  const plan = resolveProject(root);
  expect(plan.acceptance).toMatchObject({ command: "make verify", source: "project-file" });
  expect(plan.maxContinuations).toBe(3);
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  expect(resolveProject(nested).acceptance?.command).toBe("make verify");
});

test("detection ignores the npm placeholder test and recognises other runners", () => {
  const root = temp();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  expect(resolveProject(root).acceptance).toBeUndefined();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(root, "bun.lock"), "");
  expect(resolveProject(root).acceptance?.command).toBe("bun run test");
  const rust = temp();
  writeFileSync(join(rust, "Cargo.toml"), "[package]\nname='x'\n");
  expect(resolveProject(rust).acceptance?.command).toBe("cargo test");
  const go = temp();
  writeFileSync(join(go, "go.mod"), "module x\n");
  expect(resolveProject(go).acceptance?.command).toBe("go test ./...");
  const py = temp();
  mkdirSync(join(py, "tests"));
  writeFileSync(join(py, "tests", "test_a.py"), "def test_a(): pass\n");
  expect(resolveProject(py).acceptance?.command).toBe("python -m pytest -q");
  const make = temp();
  writeFileSync(join(make, "Makefile"), "build:\n\techo\ntest:\n\techo ok\n");
  expect(resolveProject(make).acceptance?.command).toBe("make test");
});

test("a project can switch long-run off with a file or a setting", () => {
  const off = temp();
  mkdirSync(join(off, ".longrun"));
  writeFileSync(join(off, ".longrun", "off"), "");
  expect(resolveProject(off).enabled).toBe(false);
  const json = temp();
  mkdirSync(join(json, ".codex"));
  writeFileSync(join(json, ".codex", "longrun.json"), JSON.stringify({ enabled: false }));
  expect(resolveProject(json).enabled).toBe(false);
});

// ---- fingerprint

test("the fingerprint changes when files change and not when nothing happens", () => {
  const repo = temp();
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one");
  git("add", "-A");
  git("commit", "-qm", "seed");
  const clean = workTreeFingerprint(repo);
  expect(workTreeFingerprint(repo)).toBe(clean);
  writeFileSync(join(repo, "a.txt"), "two!");
  const edited = workTreeFingerprint(repo);
  expect(edited).not.toBe(clean);
  writeFileSync(join(repo, "new.txt"), "x");
  expect(workTreeFingerprint(repo)).not.toBe(edited);
  expect(edited.startsWith("git:")).toBe(true);
  const plain = temp();
  writeFileSync(join(plain, "a.txt"), "1");
  const before = workTreeFingerprint(plain);
  expect(before.startsWith("dir:")).toBe(true);
  writeFileSync(join(plain, "b.txt"), "2");
  expect(workTreeFingerprint(plain)).not.toBe(before);
});

// ---- acceptance runner

test("the acceptance runner reports success, failure with an output tail, and a timeout", async () => {
  const dir = temp();
  const node = process.execPath.replaceAll("\\", "/");
  const ok = await runAcceptance(`"${node}" -e "console.log('fine')"`, dir, { timeoutMs: 20_000, tailChars: 500 });
  expect(ok.ok).toBe(true);
  expect(ok.tail).toContain("fine");
  const bad = await runAcceptance(`"${node}" -e "console.error('boom 12345 in 20ms'); process.exit(3)"`, dir, { timeoutMs: 20_000, tailChars: 500 });
  expect(bad.ok).toBe(false);
  expect(bad.exitCode).toBe(3);
  expect(bad.tail).toContain("boom");
  const again = await runAcceptance(`"${node}" -e "console.error('boom 99999 in 31ms'); process.exit(3)"`, dir, { timeoutMs: 20_000, tailChars: 500 });
  expect(again.signature).toBe(bad.signature);
  const slow = await runAcceptance(`"${node}" -e "setTimeout(()=>{}, 60000)"`, dir, { timeoutMs: 600, tailChars: 500 });
  expect(slow.ok).toBe(false);
  expect(slow.timedOut).toBe(true);
  expect(slow.tail).toContain("stopped after");
  const missing = await runAcceptance("definitely-not-a-command-xyz", dir, { timeoutMs: 20_000, tailChars: 500 });
  expect(missing.ok).toBe(false);
}, 60_000);

test("output tails are cut at a line and colour codes are removed", () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const tail = tailOf(long, 100);
  expect(tail.startsWith("…")).toBe(true);
  expect(tail.endsWith("line 199")).toBe(true);
  expect(tailOf("\u001B[31mred\u001B[0m", 100)).toBe("red");
  expect(failureSignature(1, false, "a 1234\nb")).toBe(failureSignature(1, false, "a 9999\nb"));
  expect(failureSignature(1, false, "a")).not.toBe(failureSignature(2, false, "a"));
});

test("a trailing question means the model is waiting for the user", () => {
  expect(endsWithQuestion("I changed it.\n\nWhich database should I use?")).toBe(true);
  expect(endsWithQuestion("Shall I continue (yes/no)?")).toBe(true);
  expect(endsWithQuestion("All done. Tests pass.")).toBe(false);
  expect(endsWithQuestion("Why did it fail?\n\nBecause of X.")).toBe(false);
  expect(endsWithQuestion("```\nx?\n```")).toBe(false);
});

// ---- hook decisions

test("models that are not ChatGPT web models and subagents are never touched", async () => {
  const { deps, calls } = fakeDeps();
  expect(await handleStop(stop({ model: "gpt-6-terra" }), deps)).toBeUndefined();
  expect(await handleStop(stop({ agent_id: "sub-1" }), deps)).toBeUndefined();
  expect(await handleStop(stop({ model: "gpt-6-luna", agent_id: "sub-1" }), deps)).toBeUndefined();
  expect(await handleStop(stop({ session_id: "bad id" }), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(0);
  const off = fakeDeps({ settings: () => normalizeSettings({ enabled: false }) });
  expect(await handleStop(stop(), off.deps)).toBeUndefined();
});

test("a question-only turn that changed nothing ends normally", async () => {
  const { deps, calls } = fakeDeps({ fingerprints: ["fp0", "fp0"] });
  handlePrompt(prompt("explain this repo"), deps);
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(0);
});

test("a session that began before the hooks existed is adopted without interfering", async () => {
  const { deps, calls, home } = fakeDeps();
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.log).toContain("session_adopted");
  expect(loadState(SESSION, home)).toBeDefined();
});

test("work that fails the check is sent back with the output, then the pass is announced", async () => {
  const { deps, calls, home } = fakeDeps({
    fingerprints: ["base", "edited", "after1", "edited2", "after2"],
    results: [{ ok: false, tail: "FAIL: 2 tests", signature: "a" }, { ok: true }],
  });
  handlePrompt(prompt("build the feature"), deps);
  const first = await handleStop(stop(), deps);
  expect(first).toMatchObject({ decision: "block" });
  expect((first as { reason: string }).reason).toContain(LONGRUN_MARK);
  expect((first as { reason: string }).reason).toContain("FAIL: 2 tests");
  expect((first as { reason: string }).reason).toContain("npm test");
  expect(loadState(SESSION, home)?.continuations).toBe(1);
  const second = await handleStop(stop({ stop_hook_active: true }), deps);
  expect(second).toMatchObject({ systemMessage: expect.stringContaining("Acceptance passed after 1 automatic continuation") });
  expect(loadState(SESSION, home)?.continuations).toBe(0);
  expect(calls.acceptance).toBe(2);
});

test("a passing check on the first try is silent", async () => {
  const { deps } = fakeDeps({ fingerprints: ["base", "edited", "after"], results: [{ ok: true }] });
  handlePrompt(prompt("do it"), deps);
  expect(await handleStop(stop(), deps)).toBeUndefined();
});

test("a turn that ends with a question is not continued", async () => {
  const { deps, calls } = fakeDeps({ fingerprints: ["base", "edited"] });
  handlePrompt(prompt("do it"), deps);
  expect(await handleStop(stop({ last_assistant_message: "Which framework do you prefer?" }), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(0);
});

test("the continuation limit ends the loop once and then stays quiet until the next request", async () => {
  const fingerprints = ["base", ...Array.from({ length: 40 }, (_, index) => `e${index}`)];
  const { deps, calls } = fakeDeps({
    settings: () => normalizeSettings({ maxContinuations: 2, sameFailureLimit: 50 }),
    fingerprints,
    results: Array.from({ length: 10 }, (_, index) => ({ ok: false, signature: `s${index}` })),
  });
  handlePrompt(prompt("go"), deps);
  expect((await handleStop(stop(), deps) as { decision?: string }).decision).toBe("block");
  expect((await handleStop(stop(), deps) as { decision?: string }).decision).toBe("block");
  const gave = await handleStop(stop(), deps);
  expect(gave).toMatchObject({ systemMessage: expect.stringContaining("limit of 2 automatic continuations") });
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(2);
  handlePrompt(prompt("try again"), deps);
  expect(loadState(SESSION, deps.home)?.gaveUp).toBe(false);
});

test("the same failure with no edits in between ends the loop early", async () => {
  const { deps } = fakeDeps({
    settings: () => normalizeSettings({ sameFailureLimit: 2 }),
    fingerprints: ["base", "edited", "after", "after", "after", "after", "after", "after"],
    results: [{ ok: false, signature: "x" }, { ok: false, signature: "x" }, { ok: false, signature: "x" }, { ok: false, signature: "x" }],
  });
  handlePrompt(prompt("go"), deps);
  expect((await handleStop(stop(), deps) as { decision?: string }).decision).toBe("block");
  expect((await handleStop(stop(), deps) as { decision?: string }).decision).toBe("block");
  const result = await handleStop(stop(), deps);
  expect(result).toMatchObject({ systemMessage: expect.stringContaining("same failure came back") });
});

test("the time budget per request is enforced", async () => {
  let now = 0;
  const { deps } = fakeDeps({
    settings: () => normalizeSettings({ maxHours: 1 }),
    now: () => now,
    fingerprints: ["base", "edited", "edited"],
    results: [{ ok: false }],
  });
  handlePrompt(prompt("go"), deps);
  now = 2 * 3_600_000;
  const result = await handleStop(stop(), deps);
  expect(result).toMatchObject({ systemMessage: expect.stringContaining("1 hour budget") });
});

test("without an acceptance command the user is told once how to add one", async () => {
  const { deps, calls } = fakeDeps({
    project: () => ({ enabled: true, root: "C:/p" }),
    fingerprints: ["base", "edited", "edited", "edited2"],
  });
  handlePrompt(prompt("go"), deps);
  const first = await handleStop(stop(), deps);
  expect(first).toMatchObject({ systemMessage: expect.stringContaining("acceptance: npm test") });
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(0);
});

test("a project that switched long-run off is left alone", async () => {
  const { deps, calls } = fakeDeps({ project: () => ({ enabled: false, root: "C:/p" }), fingerprints: ["base", "edited"] });
  handlePrompt(prompt("go"), deps);
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(0);
});

test("feedback injected by the Stop hook does not count as a new request", async () => {
  const { deps, home } = fakeDeps({ fingerprints: ["base", "edited", "after", "later"], results: [{ ok: false }] });
  handlePrompt(prompt("go"), deps);
  await handleStop(stop(), deps);
  expect(loadState(SESSION, home)?.continuations).toBe(1);
  handlePrompt(prompt(`${LONGRUN_MARK} The acceptance check failed`), deps);
  expect(loadState(SESSION, home)?.continuations).toBe(1);
  handlePrompt(prompt("a real follow-up"), deps);
  expect(loadState(SESSION, home)?.continuations).toBe(0);
});

test("state survives a round trip and rejects tampering", () => {
  const home = temp();
  const state = freshState(SESSION, "fp", 5);
  saveState({ ...state, continuations: 3 }, home);
  expect(loadState(SESSION, home)?.continuations).toBe(3);
  expect(loadState("../../etc", home)).toBeUndefined();
  writeFileSync(join(home, "longrun", "state", `${SESSION}.json`), "{broken");
  expect(loadState(SESSION, home)).toBeUndefined();
});

// ---- the real CLI, fail-open

function runCli(args: string[], home: string, input: string) {
  return spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "cli.ts"), "--home", home, ...args], {
    input, encoding: "utf8", timeout: 60_000, env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, "codex") },
  });
}

test("the hook command fails open on garbage and prints a block decision for failing work", () => {
  const home = temp();
  const garbage = runCli(["hook", "stop"], home, "not json");
  expect(garbage.status).toBe(0);
  expect(garbage.stdout).toBe("");

  const project = temp("longrun-project-");
  const git = (...args: string[]) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(project, "AGENTS.md"), `acceptance: "${process.execPath.replaceAll("\\", "/")}" -e "console.log('NOT YET'); process.exit(1)"\n`);
  git("add", "-A");
  git("commit", "-qm", "seed");
  const base = { session_id: SESSION, cwd: project, model: "chatgpt-web/gpt-6-sol", permission_mode: "bypassPermissions" };
  expect(runCli(["hook", "prompt"], home, JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "build it" })).status).toBe(0);
  writeFileSync(join(project, "work.txt"), "changed");
  const result = runCli(["hook", "stop"], home, JSON.stringify({ ...base, hook_event_name: "Stop", last_assistant_message: "Done." }));
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout.trim());
  expect(output.decision).toBe("block");
  expect(output.reason).toContain("NOT YET");
  expect(readFileSync(join(home, "longrun", "hook.log"), "utf8")).toContain('"event":"continue"');
}, 120_000);

// ---- trust

test("project commands only run in folders Codex trusts, or when the session already runs without approvals", () => {
  const dir = temp();
  const config = join(dir, "config.toml");
  const bs = String.fromCharCode(92);
  const win = (path: string) => path.replaceAll("/", bs);
  writeFileSync(config, [
    `[projects.'${win("C:/Work/trusted")}']`, 'trust_level = "trusted"', "",
    `[projects.'${win("C:/Work/other")}']`, 'trust_level = "untrusted"', "",
    `[projects.'${bs}${bs}?${bs}${win("C:/Work/verbatim")}']`, 'trust_level = "trusted"', "",
  ].join(String.fromCharCode(10)));
  const trusted = trustedProjects(config);
  expect(trusted).toHaveLength(2);
  expect(insideTrustedProject(win("C:/Work/trusted"), trusted)).toBe(true);
  expect(insideTrustedProject(win("C:/Work/trusted/packages/app"), trusted)).toBe(true);
  expect(insideTrustedProject(win("C:/Work/Verbatim/x"), trusted)).toBe(true);
  expect(insideTrustedProject(win("C:/Work/other"), trusted)).toBe(false);
  expect(insideTrustedProject(win("C:/Work/trusted-but-not"), trusted)).toBe(false);
  expect(mayRunProjectCommands(win("C:/Elsewhere"), "default", config)).toBe(false);
  expect(mayRunProjectCommands(win("C:/Elsewhere"), "bypassPermissions", config)).toBe(true);
  expect(mayRunProjectCommands(win("C:/Work/trusted"), "default", config)).toBe(true);
  expect(trustedProjects(join(dir, "missing.toml"))).toEqual([]);
  writeFileSync(config, "not = = toml");
  expect(trustedProjects(config)).toEqual([]);
});

test("an untrusted folder gets one explanation and its acceptance command is not run", async () => {
  const { deps, calls } = fakeDeps({ mayRun: () => false, fingerprints: ["base", "edited", "edited2"] });
  handlePrompt(prompt("go"), deps);
  const first = await handleStop(stop(), deps);
  expect(first).toMatchObject({ systemMessage: expect.stringContaining("not trusted in Codex") });
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.acceptance).toBe(0);
});

test("through the real CLI an untrusted folder is explained once and its command never runs", () => {
  const home = temp();
  const project = temp("longrun-project-");
  const git = (...args: string[]) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  const slash = (path: string) => path.replaceAll(String.fromCharCode(92), "/");
  const marker = slash(join(project, "ran.txt"));
  const command = `"${slash(process.execPath)}" -e "require('fs').writeFileSync('${marker}', 'x'); process.exit(1)"`;
  writeFileSync(join(project, "AGENTS.md"), `acceptance: ${command}${String.fromCharCode(10)}`);
  git("add", "-A");
  git("commit", "-qm", "seed");
  const base = { session_id: SESSION, cwd: project, model: "chatgpt-web/gpt-6-sol", permission_mode: "default" };
  runCli(["hook", "prompt"], home, JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "build it" }));
  writeFileSync(join(project, "work.txt"), "changed");
  const result = runCli(["hook", "stop"], home, JSON.stringify({ ...base, hook_event_name: "Stop", last_assistant_message: "Done." }));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim()).systemMessage).toContain("not trusted in Codex");
  expect(existsSync(marker)).toBe(false);
}, 120_000);

// ---- Luna drives, Sol works

test("a Luna driver session is supervised like a web model and is told to hand the fix to a worker", async () => {
  const luna = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: "boom" }] });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), luna.deps);
  const output = await handleStop(stop({ model: "gpt-6-luna" }), luna.deps);
  expect(output).toMatchObject({ decision: "block" });
  expect((output as { reason: string }).reason).toContain("You are the driver");
  expect((output as { reason: string }).reason).toContain("boom");
  const web = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false }] });
  handlePrompt(prompt("Build it"), web.deps);
  expect((await handleStop(stop(), web.deps) as { reason: string }).reason).not.toContain("You are the driver");
});

test("a worker that reports a blocker is not sent round the acceptance loop, a driver's own report is not affected", async () => {
  const blocked = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: "no go" }] });
  handlePrompt(prompt("Build it"), blocked.deps);
  expect(await handleStop(stop({ last_assistant_message: "Wrote the handler.\nBLOCKED: Go 1.26 is not installed" }), blocked.deps)).toBeUndefined();
  expect(blocked.calls.acceptance).toBe(0);
  const luna = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: "no go" }] });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), luna.deps);
  const output = await handleStop(stop({ model: "gpt-6-luna", last_assistant_message: "BLOCKED: x" }), luna.deps);
  expect(output).toMatchObject({ decision: "block" });
  expect((output as { reason: string }).reason).toContain("manual steps");
});

test("Luna is left alone when the driver setting is off", async () => {
  const off = fakeDeps({ settings: () => normalizeSettings({ driver: false }), fingerprints: ["a", "b", "b"], results: [{ ok: false }] });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), off.deps);
  expect(await handleStop(stop({ model: "gpt-6-luna" }), off.deps)).toBeUndefined();
  expect(off.calls.acceptance).toBe(0);
});

test("worker settings are validated so only a ChatGPT web model and a known effort are accepted", () => {
  expect(normalizeSettings({}).workerModel).toBe("chatgpt-web/gpt-6-sol");
  expect(normalizeSettings({}).workerEffort).toBe("xhigh");
  expect(normalizeSettings({ workerEffort: "xhigh", workerModel: "chatgpt-web/gpt-6-pro" })).toMatchObject({ workerEffort: "xhigh", workerModel: "chatgpt-web/gpt-6-pro" });
  expect(normalizeSettings({ workerEffort: "instant", workerModel: "gpt-6-luna" })).toMatchObject({ workerEffort: "xhigh", workerModel: "chatgpt-web/gpt-6-sol" });
  expect(normalizeSettings({ workerModel: "chatgpt-web/x y; rm" }).workerModel).toBe("chatgpt-web/gpt-6-sol");
  expect(normalizeSettings({ driverModelPrefixes: [] }).driverModelPrefixes).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
});

test("each request to a Luna driver carries the standing request to use the worker, other sessions get nothing", () => {
  const luna = fakeDeps();
  const output = handlePrompt(prompt("Build a CLI", { model: "gpt-6-luna" }), luna.deps);
  expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
  const context = (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  expect(context).toContain("Luna drives, Sol works");
  expect(context).toContain(".longrun/brief.md");
  expect(context).toContain("Your session model is gpt-6-luna");
  expect(context).toContain("analysis, architecture, review and investigation");
  expect(context).toContain("chatgpt-web/gpt-6-sol at xhigh effort");
  expect(context.startsWith(LONGRUN_MARK)).toBe(true);
  expect(handlePrompt(prompt("Build a CLI"), fakeDeps().deps)).toBeUndefined();
  expect(handlePrompt(prompt(`${LONGRUN_MARK} The acceptance check failed`, { model: "gpt-6-luna" }), fakeDeps().deps)).toBeUndefined();
  expect(handlePrompt(prompt("Build", { model: "gpt-6-luna", agent_id: "sub" }), fakeDeps().deps)).toBeUndefined();
  const off = fakeDeps({ settings: () => normalizeSettings({ driver: false }) });
  expect(handlePrompt(prompt("Build", { model: "gpt-6-luna" }), off.deps)).toBeUndefined();
});

test("a worker run session is never sent round the acceptance loop, a direct ChatGPT web chat still is", async () => {
  const worker = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: "whole check failed" }] });
  expect(handlePrompt(prompt(withWorkerRules("Fix the parser")), worker.deps)).toBeUndefined();
  expect(loadState(SESSION, worker.home)).toMatchObject({ worker: true });
  expect(worker.calls.log).toContain("worker_session");
  expect(await handleStop(stop({ last_assistant_message: "Fixed it." }), worker.deps)).toBeUndefined();
  expect(worker.calls.acceptance).toBe(0);
  const direct = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: "whole check failed" }] });
  handlePrompt(prompt("Fix the parser"), direct.deps);
  expect(loadState(SESSION, direct.home)?.worker).toBe(false);
  expect(await handleStop(stop({ last_assistant_message: "Fixed it." }), direct.deps)).toMatchObject({ decision: "block" });
  expect(direct.calls.acceptance).toBe(1);
});

const RUNNING: WorkerLock = { pid: 4242, cwd: "C:/p", startedAt: 1_000_000 - 7 * 60_000, heartbeatAt: 1_000_000, model: "chatgpt-web/gpt-6-sol", effort: "xhigh" };

test("a driver whose worker is still running is sent back to it instead of running the check beside it", async () => {
  const busy = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false }], waitForWorker: async () => RUNNING });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), busy.deps);
  const output = await handleStop(stop({ model: "gpt-6-luna" }), busy.deps);
  expect(output).toMatchObject({ decision: "block" });
  const reason = (output as { reason: string }).reason;
  expect(reason).toContain("A worker is still running in this folder");
  expect(reason).toContain("pid 4242");
  expect(reason).toContain(".longrun/worker-report.md");
  expect(busy.calls.acceptance).toBe(0);
  expect(loadState(SESSION, busy.home)?.continuations).toBe(1);
  expect(busy.calls.log).toContain("worker_busy");
  const free = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: true }], waitForWorker: async () => undefined });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), free.deps);
  expect(await handleStop(stop({ model: "gpt-6-luna" }), free.deps)).toBeUndefined();
  expect(free.calls.acceptance).toBe(1);
});

test("a check that fails because a tool is missing from its plain shell says so and points at an acceptance script", async () => {
  const missing = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: 'error: Executable not found in $PATH: "go"\n      code: "ENOENT"' }] });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), missing.deps);
  const reason = ((await handleStop(stop({ model: "gpt-6-luna" }), missing.deps)) as { reason: string }).reason;
  expect(reason).toContain("a tool missing from the shell this check runs in");
  expect(reason).toContain(".longrun/acceptance.cmd");
  expect(reason).not.toContain("\n\n");
  const code = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false, tail: "expected 3 but got 4" }] });
  handlePrompt(prompt("Build it", { model: "gpt-6-luna" }), code.deps);
  expect(((await handleStop(stop({ model: "gpt-6-luna" }), code.deps)) as { reason: string }).reason).not.toContain("missing from the shell");
  for (const line of ["'go' is not recognized as an internal or external command", "bash: go: command not found", "spawn go ENOENT", "The term 'go' is not recognized as a name of a cmdlet"]) {
    expect(MISSING_TOOL.test(line)).toBe(true);
  }
  expect(MISSING_TOOL.test("1 test failed: file not found fixtures/a.json")).toBe(false);
});

test("a later prompt in a worker's session leaves it a worker", async () => {
  const worker = fakeDeps({ fingerprints: ["a", "b", "b", "b"], results: [{ ok: false }] });
  handlePrompt(prompt(withWorkerRules("Fix the parser")), worker.deps);
  handlePrompt(prompt("Also rename the helper"), worker.deps);
  expect(loadState(SESSION, worker.home)?.worker).toBe(true);
  expect(await handleStop(stop(), worker.deps)).toBeUndefined();
  expect(worker.calls.acceptance).toBe(0);
});
