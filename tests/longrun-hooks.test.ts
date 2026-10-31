import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { workTreeFingerprint } from "../src/longrun/fingerprint";
import { LONGRUN_MARK, endsWithQuestion, handlePrompt, handleStop, type HookDeps } from "../src/longrun/hooks";
import { resolveProject } from "../src/longrun/project";
import { DEFAULT_LONGRUN_SETTINGS, loadLongrunSettings, normalizeSettings, saveLongrunSettings } from "../src/longrun/settings";
import { excludeOwnFiles, shipState, type ShipState } from "../src/longrun/ship";
import { loadState, saveState, freshState } from "../src/longrun/state";
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
const LUNA = "gpt-6-luna";

function fakeDeps(over: Partial<HookDeps> & { fingerprints?: string[]; ships?: Array<ShipState | undefined> } = {}) {
  const home = over.home ?? temp("longrun-home-");
  const fingerprints = over.fingerprints ?? [];
  const ships = over.ships ?? [];
  let clock = 1_000_000;
  const calls = { ship: 0, log: [] as string[] };
  const deps: HookDeps = {
    home,
    now: () => (clock += 1000),
    settings: () => normalizeSettings({}),
    project: () => ({ enabled: true, root: "C:/p" }),
    fingerprint: () => fingerprints.shift() ?? "fp-same",
    ship: () => {
      calls.ship += 1;
      return ships.length > 0 ? ships.shift() : { dirty: true, ahead: 0 };
    },
    log: (event) => calls.log.push(event),
    ...over,
  };
  return { deps, calls, home };
}

const stop = (extra: Record<string, unknown> = {}) => ({ session_id: SESSION, cwd: "C:/p", model: LUNA, last_assistant_message: "Done.", ...extra });
const prompt = (text: string, extra: Record<string, unknown> = {}) => ({ session_id: SESSION, cwd: "C:/p", model: LUNA, prompt: text, ...extra });

// ---- settings

test("settings are clamped so a bad file cannot make the reminders unbounded", () => {
  const settings = normalizeSettings({ maxContinuations: 1e9, maxHours: -4, modelPrefixes: [] });
  expect(settings.maxContinuations).toBe(20);
  expect(settings.maxHours).toBe(0.25);
  expect(settings.modelPrefixes).toEqual(["chatgpt-web/"]);
  expect(normalizeSettings("garbage").enabled).toBe(true);
  expect(DEFAULT_LONGRUN_SETTINGS.maxContinuations).toBe(3);
  expect(Object.keys(normalizeSettings({ acceptanceTimeoutMinutes: 5, sameFailureLimit: 9 }))).not.toContain("acceptanceTimeoutMinutes");
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

// ---- project

test("a project is found from its markers and never carries a test command", () => {
  const root = temp();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  writeFileSync(join(root, "AGENTS.md"), "acceptance: node check.js\n");
  const plan = resolveProject(root);
  expect(plan.enabled).toBe(true);
  expect(plan.root).toBe(root);
  expect(Object.keys(plan)).not.toContain("acceptance");
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "longrun.json"), JSON.stringify({ maxContinuations: 2 }));
  expect(resolveProject(root).maxContinuations).toBe(2);
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  expect(resolveProject(nested).maxContinuations).toBe(2);
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

// ---- fingerprint and ship state

function repoWithSeed() {
  const repo = temp();
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return { repo, git };
}

test("the fingerprint changes when files change and not when nothing happens", () => {
  const { repo } = repoWithSeed();
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

test("ship state sees uncommitted work and ignores the long-run folder", () => {
  const { repo, git } = repoWithSeed();
  expect(shipState(repo)).toEqual({ dirty: false, ahead: 0 });
  mkdirSync(join(repo, ".longrun"));
  writeFileSync(join(repo, ".longrun", "PROGRESS.md"), "notes");
  expect(shipState(repo)?.dirty).toBe(false);
  writeFileSync(join(repo, "work.txt"), "x");
  expect(shipState(repo)?.dirty).toBe(true);
  git("add", "-A");
  git("commit", "-qm", "work");
  expect(shipState(repo)?.dirty).toBe(false);
  expect(shipState(temp())).toBeUndefined();
});

test("the long-run folder is excluded from git once, without touching the committed ignore file", () => {
  const { repo } = repoWithSeed();
  excludeOwnFiles(repo);
  excludeOwnFiles(repo);
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  expect(exclude.split(".longrun/").length).toBe(2);
  expect(existsSync(join(repo, ".gitignore"))).toBe(false);
});

test("a trailing question means the model is waiting for the user", () => {
  expect(endsWithQuestion("I changed it.\n\nWhich database should I use?")).toBe(true);
  expect(endsWithQuestion("Shall I continue (yes/no)?")).toBe(true);
  expect(endsWithQuestion("All done. Pushed.")).toBe(false);
  expect(endsWithQuestion("Why did it fail?\n\nBecause of X.")).toBe(false);
  expect(endsWithQuestion("```\nx?\n```")).toBe(false);
});

// ---- hook decisions

test("only a Luna driver is ever sent back: web models, other models and subagents are left alone", async () => {
  const { deps, calls } = fakeDeps({ fingerprints: ["a", "b", "b", "b", "b", "b"] });
  expect(await handleStop(stop({ model: "chatgpt-web/gpt-6-sol" }), deps)).toBeUndefined();
  expect(await handleStop(stop({ model: "gpt-6-terra" }), deps)).toBeUndefined();
  expect(await handleStop(stop({ agent_id: "sub-1" }), deps)).toBeUndefined();
  expect(await handleStop(stop({ session_id: "bad id" }), deps)).toBeUndefined();
  expect(calls.ship).toBe(0);
  const off = fakeDeps({ settings: () => normalizeSettings({ enabled: false }) });
  expect(await handleStop(stop(), off.deps)).toBeUndefined();
});

test("a question-only turn that changed nothing ends normally", async () => {
  const { deps, calls } = fakeDeps({ fingerprints: ["fp0", "fp0"] });
  handlePrompt(prompt("explain this repo"), deps);
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.ship).toBe(0);
});

test("a session that began before the hooks existed is adopted without interfering", async () => {
  const { deps, calls, home } = fakeDeps();
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.log).toContain("session_adopted");
  expect(loadState(SESSION, home)).toBeDefined();
});

test("work left uncommitted is sent back to be committed and pushed, with no test or build asked for", async () => {
  const { deps, calls, home } = fakeDeps({
    fingerprints: ["base", "edited", "after"],
    ships: [{ dirty: true, ahead: 0 }, { dirty: false, ahead: 0 }],
  });
  handlePrompt(prompt("build the feature"), deps);
  const first = await handleStop(stop(), deps);
  expect(first).toMatchObject({ decision: "block" });
  const reason = (first as { reason: string }).reason;
  expect(reason).toContain(LONGRUN_MARK);
  expect(reason).toContain("changes that are not committed");
  expect(reason).toContain("push to main");
  expect(reason).toContain("GitHub Actions");
  expect(reason).toContain("Do not run tests, builds or package scripts");
  expect(reason).not.toContain("acceptance");
  expect(loadState(SESSION, home)?.continuations).toBe(1);
  expect(await handleStop(stop({ stop_hook_active: true }), deps)).toBeUndefined();
  expect(loadState(SESSION, home)?.continuations).toBe(0);
  expect(calls.log).toContain("shipped");
});

test("unpushed commits are named in the reminder", async () => {
  const { deps } = fakeDeps({ fingerprints: ["base", "edited"], ships: [{ dirty: false, ahead: 2 }] });
  handlePrompt(prompt("do it"), deps);
  const output = await handleStop(stop(), deps);
  expect((output as { reason: string }).reason).toContain("2 commits that are not pushed");
});

test("work that is already committed and pushed is left alone, and so is a folder that is not a git work tree", async () => {
  const done = fakeDeps({ fingerprints: ["base", "edited", "after"], ships: [{ dirty: false, ahead: 0 }] });
  handlePrompt(prompt("do it"), done.deps);
  expect(await handleStop(stop(), done.deps)).toBeUndefined();
  const none = fakeDeps({ fingerprints: ["base", "edited", "after"], ships: [undefined] });
  handlePrompt(prompt("do it"), none.deps);
  expect(await handleStop(stop(), none.deps)).toBeUndefined();
});

test("a turn that ends with a question is not sent back", async () => {
  const { deps, calls } = fakeDeps({ fingerprints: ["base", "edited"] });
  handlePrompt(prompt("do it"), deps);
  expect(await handleStop(stop({ last_assistant_message: "Which framework do you prefer?" }), deps)).toBeUndefined();
  expect(calls.ship).toBe(0);
});

test("the reminder limit ends the loop once and then stays quiet until the next request", async () => {
  const { deps } = fakeDeps({
    settings: () => normalizeSettings({ maxContinuations: 2 }),
    fingerprints: ["base", ...Array.from({ length: 20 }, (_, index) => `e${index}`)],
  });
  handlePrompt(prompt("go"), deps);
  expect((await handleStop(stop(), deps) as { decision?: string }).decision).toBe("block");
  expect((await handleStop(stop(), deps) as { decision?: string }).decision).toBe("block");
  const gave = await handleStop(stop(), deps);
  expect(gave).toMatchObject({ systemMessage: expect.stringContaining("after 2 reminders") });
  expect(await handleStop(stop(), deps)).toBeUndefined();
  handlePrompt(prompt("try again"), deps);
  expect(loadState(SESSION, deps.home)?.gaveUp).toBe(false);
});

test("the time budget per request is enforced", async () => {
  let now = 0;
  const { deps } = fakeDeps({ settings: () => normalizeSettings({ maxHours: 1 }), now: () => now, fingerprints: ["base", "edited", "edited"] });
  handlePrompt(prompt("go"), deps);
  now = 2 * 3_600_000;
  expect(await handleStop(stop(), deps)).toMatchObject({ systemMessage: expect.stringContaining("1 hour budget") });
});

test("a worker still running in the folder keeps the driver from finishing", async () => {
  const lock: WorkerLock = { pid: 4242, cwd: "C:/p", startedAt: 1, heartbeatAt: 1, model: "chatgpt-web/gpt-6-sol", effort: "high" };
  const { deps, calls } = fakeDeps({ fingerprints: ["base", "edited"], waitForWorker: async () => lock });
  handlePrompt(prompt("go"), deps);
  const output = await handleStop(stop(), deps);
  expect(output).toMatchObject({ decision: "block" });
  expect((output as { reason: string }).reason).toContain("A worker is still running");
  expect(calls.ship).toBe(0);
  expect(calls.log).toContain("worker_busy");
});

test("a project that switched long-run off is left alone", async () => {
  const { deps, calls } = fakeDeps({ project: () => ({ enabled: false, root: "C:/p" }), fingerprints: ["base", "edited"] });
  handlePrompt(prompt("go"), deps);
  expect(await handleStop(stop(), deps)).toBeUndefined();
  expect(calls.ship).toBe(0);
});

test("feedback injected by the Stop hook does not count as a new request", async () => {
  const { deps, home } = fakeDeps({ fingerprints: ["base", "edited", "after", "later"] });
  handlePrompt(prompt("go"), deps);
  await handleStop(stop(), deps);
  expect(loadState(SESSION, home)?.continuations).toBe(1);
  handlePrompt(prompt(`${LONGRUN_MARK} The work is not shipped yet`), deps);
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

test("the hook command fails open on garbage and sends a driver back to commit uncommitted work, running nothing", () => {
  const home = temp();
  const garbage = runCli(["hook", "stop"], home, "not json");
  expect(garbage.status).toBe(0);
  expect(garbage.stdout).toBe("");

  const { repo } = repoWithSeed();
  const marker = join(repo, "ran.txt");
  writeFileSync(join(repo, "AGENTS.md"), `acceptance: "${process.execPath.replaceAll("\\", "/")}" -e "require('fs').writeFileSync('ran.txt','x')"\n`);
  spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "agents"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  const base = { session_id: SESSION, cwd: repo, model: LUNA };
  expect(runCli(["hook", "prompt"], home, JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "build it" })).status).toBe(0);
  writeFileSync(join(repo, "work.txt"), "changed");
  const result = runCli(["hook", "stop"], home, JSON.stringify({ ...base, hook_event_name: "Stop", last_assistant_message: "Done." }));
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout.trim());
  expect(output.decision).toBe("block");
  expect(output.reason).toContain("commit everything");
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(join(home, "longrun", "hook.log"), "utf8")).toContain('"event":"remind_ship"');
}, 120_000);

// ---- Luna drives, Sol works

test("the driver is told the flow: no tests, commit, push, GitHub Actions", async () => {
  const luna = fakeDeps();
  const output = handlePrompt(prompt("Build it"), luna.deps);
  const context = (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  expect(context).toContain("you ARE the Luna driver");
  expect(context).toContain("Nobody runs tests, builds, package scripts");
  expect(context).toContain("push to main");
  expect(context).toContain("GitHub Actions");
  expect(context).not.toContain("acceptance command yourself");
});

test("a worker session is recognised by its first prompt and left to the driver", async () => {
  const worker = fakeDeps({ fingerprints: ["a", "b", "b"] });
  handlePrompt(prompt(withWorkerRules("Write the handler."), { model: "chatgpt-web/gpt-6-sol" }), worker.deps);
  expect(loadState(SESSION, worker.home)?.worker).toBe(true);
  expect(await handleStop(stop({ model: LUNA }), worker.deps)).toBeUndefined();
  expect(worker.calls.ship).toBe(0);
});
