import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCheckpoint } from "../src/longrun/checkpoint";
import { classifyFailure, forbiddenCommand, formatWorkerResult, progressLine, runWorker } from "../src/longrun/worker";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "longrun-flow-"));
  cleanup.push(path);
  return path;
}

const waits: number[] = [];
const BASE = { model: "chatgpt-web/gpt-6-sol", effort: "high", sleep: async (ms: number) => { waits.push(ms); } };

function fakeCodex(dir: string, script: string): { exe: string; args: string[] } {
  const file = join(dir, "fake-codex.cjs");
  writeFileSync(file, script);
  return { exe: process.execPath, args: [file] };
}

function seededRepo() {
  const repo = temp();
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return { repo, git };
}

test("failures are told apart by cause: waiting causes retry for free, the rest spend an attempt", () => {
  expect(classifyFailure("ChatGPT is waiting for plugin permission")).toMatchObject({ kind: "permission", free: true });
  expect(classifyFailure("Model is at capacity, please try again later")).toMatchObject({ kind: "capacity", free: true, waitMs: 300_000 });
  expect(classifyFailure("ChatGPT model/effort control did not become ready")).toMatchObject({ kind: "unreachable", free: true });
  expect(classifyFailure("anything", { stalled: true })).toMatchObject({ kind: "stalled", free: false });
  expect(classifyFailure("anything", { timedOut: true })).toMatchObject({ kind: "timeout", free: false });
  expect(classifyFailure("anything", { forbidden: "npm test" })).toMatchObject({ kind: "forbidden", free: false });
  expect(classifyFailure("some other error")).toMatchObject({ kind: "other", free: false });
});

test("test, build and package-script commands are forbidden, reading and editing are not", () => {
  for (const command of [
    "npm test", "bun test ./tests", "bun run check", "pnpm run build", "npx vitest run", "yarn lint", "pytest -q", "cargo test", "go test ./...", "dotnet build",
    'powershell.exe -NoProfile -Command "npm run test"', "cd app && npm run build", 'cmd.exe /c "bun x tsc --noEmit"', "python -m pytest", "make test",
  ]) expect([command, forbiddenCommand(command)]).toEqual([command, true]);
  for (const command of [
    "git status --short", 'rg "npm test" docs', "cat package.json", "Get-Content src/app.ts", "node scripts/seed.js", "git diff --stat", "ls tests", "sed -n 1,40p README.md",
  ]) expect([command, forbiddenCommand(command)]).toEqual([command, false]);
});

test("progress lines name what the worker said, changed and ran", () => {
  expect(progressLine({ type: "item.completed", item: { type: "agent_message", text: "Planned the  change\nin two steps" } })).toBe("- said: Planned the change in two steps");
  expect(progressLine({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }, { path: "b.ts" }] } })).toBe("- changed: a.ts, b.ts");
  expect(progressLine({ type: "item.completed", item: { type: "command_execution", command: "git diff" } })).toBe("- ran: git diff");
  expect(progressLine({ type: "item.started", item: { type: "agent_message", text: "x" } })).toBeUndefined();
});

test("an attempt that goes silent is cut off, saved, and retried from its progress notes", async () => {
  const dir = temp();
  const codex = fakeCodex(dir, `
    const fs = require("node:fs"); const counter = process.cwd() + "/count.txt";
    let input = ""; process.stdin.on("data", (c) => input += c);
    process.stdin.on("end", () => {
      const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
      fs.writeFileSync(counter, String(n)); fs.writeFileSync(process.cwd() + "/brief-" + n + ".txt", input);
      if (n === 1) {
        console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "parser.ts is half rewritten" } }));
        setInterval(() => {}, 1000);
        return;
      }
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "finished" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    });`);
  const result = await runWorker({ cwd: dir, brief: "Do the job", timeoutMs: 30_000, idleMs: 800, attempts: 2, codex, ...BASE });
  expect(result).toMatchObject({ ok: true, attempts: 2, message: "finished" });
  const second = readFileSync(join(dir, "brief-2.txt"), "utf8");
  expect(second).toContain("produced no output");
  expect(second).toContain("What that attempt last reported");
  expect(second).toContain("parser.ts is half rewritten");
  expect(second).toContain("do not start over");
  const notes = readFileSync(join(dir, ".longrun", "worker-progress.md"), "utf8");
  expect(notes).toContain("## Attempt 1");
  expect(notes).toContain("- said: parser.ts is half rewritten");
  expect(notes).toContain("## Attempt 2");
}, 30_000);

test("an attempt that starts a test or build is stopped at once and the retry forbids it", async () => {
  const dir = temp();
  const codex = fakeCodex(dir, `
    const fs = require("node:fs"); const counter = process.cwd() + "/count.txt";
    let input = ""; process.stdin.on("data", (c) => input += c);
    process.stdin.on("end", () => {
      const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
      fs.writeFileSync(counter, String(n)); fs.writeFileSync(process.cwd() + "/brief-" + n + ".txt", input);
      if (n === 1) {
        console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "bun test ./tests" } }));
        setInterval(() => {}, 1000);
        return;
      }
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "wrote it without running anything" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    });`);
  const result = await runWorker({ cwd: dir, brief: "Do the job", timeoutMs: 30_000, attempts: 2, codex, ...BASE });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  const second = readFileSync(join(dir, "brief-2.txt"), "utf8");
  expect(second).toContain("forbidden command (bun test ./tests)");
  expect(second).toContain("Do not run any; only read, plan and edit files.");
}, 30_000);

test("a busy ChatGPT is waited out without spending an attempt", async () => {
  const dir = temp();
  waits.length = 0;
  const codex = fakeCodex(dir, `
    const fs = require("node:fs"); const counter = process.cwd() + "/count.txt";
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
      fs.writeFileSync(counter, String(n));
      if (n <= 3) { console.log(JSON.stringify({ type: "turn.failed", error: { message: "Model is at capacity" } })); process.exit(1); }
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    });`);
  const result = await runWorker({ cwd: dir, brief: "x", timeoutMs: 20_000, attempts: 1, codex, ...BASE });
  expect(result).toMatchObject({ ok: true, attempts: 4 });
  expect(waits).toEqual([300_000, 300_000, 300_000]);
}, 30_000);

test("a failure leaves the work saved as a checkpoint and says what caused it", async () => {
  const { repo, git } = seededRepo();
  const codex = fakeCodex(repo, `
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      require("node:fs").writeFileSync(process.cwd() + "/new.txt", "half done work");
      console.log(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })); process.exit(1);
    });`);
  const result = await runWorker({ cwd: repo, brief: "x", timeoutMs: 20_000, attempts: 1, codex, ...BASE });
  expect(result.ok).toBe(false);
  expect(result.failureKind).toBe("other");
  expect(result.checkpoint).toMatch(/^refs\/longrun\/checkpoint-/);
  expect(git("show", `${result.checkpoint}:new.txt`).stdout).toBe("half done work");
  expect(git("status", "--short").stdout).toContain("new.txt");
  expect(git("log", "--oneline", "-1").stdout).toContain("seed");
  expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".longrun/");
  const text = formatWorkerResult(result);
  expect(text).toContain("The work is saved as refs/longrun/checkpoint-");
  expect(text).toContain("The files are kept.");
  expect(text).not.toContain("acceptance");
});

test("checkpoints are skipped when nothing changed and outside a git work tree", () => {
  const { repo, git } = seededRepo();
  expect(saveCheckpoint(repo, "nothing")).toBeUndefined();
  expect(saveCheckpoint(temp(), "no repo")).toBeUndefined();
  writeFileSync(join(repo, "b.txt"), "two");
  expect(saveCheckpoint(repo, "something")).toMatch(/^refs\/longrun\//);
  expect(git("for-each-ref", "refs/longrun/").stdout.length).toBeGreaterThan(0);
  expect(existsSync(join(repo, "b.txt"))).toBe(true);
});
