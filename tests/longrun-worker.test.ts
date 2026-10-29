import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCommandLine } from "../src/longrun/cli";
import { findCodex, formatWorkerResult, parseWorkerEvents, runWorker } from "../src/longrun/worker";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "longrun-worker-"));
  cleanup.push(path);
  return path;
}

const event = (value: unknown) => JSON.stringify(value);
const BASE = { model: "chatgpt-web/gpt-6-sol", effort: "high", sandbox: "workspace-write" };

test("worker events: the last agent message wins, reconnect notices are ignored, a failed turn is an error", () => {
  expect(parseWorkerEvents([
    event({ type: "thread.started" }),
    event({ type: "error", message: "Reconnecting... 1/5 (stream disconnected)" }),
    event({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    event({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    event({ type: "turn.completed" }),
    "not json",
  ])).toEqual({ completed: true, message: "final", error: "" });
  expect(parseWorkerEvents([
    event({ type: "error", message: "ChatGPT model/effort control did not become ready" }),
    event({ type: "turn.failed", error: { message: "boom" } }),
  ])).toEqual({ completed: false, message: "", error: "boom" });
});

// A stand-in for Codex: a node script that prints scripted JSONL and records the brief it was given.
function fakeCodex(dir: string, script: string): { exe: string; args: string[] } {
  const file = join(dir, "fake-codex.cjs");
  writeFileSync(file, script);
  return { exe: process.execPath, args: [file] };
}

test("a worker that finishes is reported with its message", async () => {
  const dir = temp();
  const codex = fakeCodex(dir, `
    let input = ""; process.stdin.on("data", (c) => input += c);
    process.stdin.on("end", () => {
      require("node:fs").writeFileSync(process.cwd() + "/brief-seen.txt", input + "|" + process.argv.slice(2).join(" "));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done: wrote calc.js" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    });`);
  const result = await runWorker({ cwd: dir, brief: "Build calc.js", timeoutMs: 20_000, attempts: 3, codex, ...BASE });
  expect(result).toMatchObject({ ok: true, attempts: 1, message: "done: wrote calc.js" });
  const seen = readFileSync(join(dir, "brief-seen.txt"), "utf8");
  expect(seen).toContain("Build calc.js");
  expect(seen).toContain('-m chatgpt-web/gpt-6-sol -c model_reasoning_effort="high" -s workspace-write');
  expect(formatWorkerResult(result)).toContain("WORKER FINISHED (attempt 1)");
});

test("a broken chat is retried in a fresh one and the second brief names the failure", async () => {
  const dir = temp();
  const codex = fakeCodex(dir, `
    const fs = require("node:fs"); const counter = process.cwd() + "/count.txt";
    let input = ""; process.stdin.on("data", (c) => input += c);
    process.stdin.on("end", () => {
      const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
      fs.writeFileSync(counter, String(n)); fs.writeFileSync(process.cwd() + "/brief-" + n + ".txt", input);
      if (n === 1) { console.log(JSON.stringify({ type: "turn.failed", error: { message: "ChatGPT surface lost" } })); process.exit(1); }
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "recovered" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    });`);
  const result = await runWorker({ cwd: dir, brief: "Do the job", timeoutMs: 20_000, attempts: 3, codex, ...BASE });
  expect(result).toMatchObject({ ok: true, attempts: 2, message: "recovered" });
  expect(readFileSync(join(dir, "brief-1.txt"), "utf8")).toBe("Do the job");
  const second = readFileSync(join(dir, "brief-2.txt"), "utf8");
  expect(second).toContain("Do the job");
  expect(second).toContain("A previous worker attempt on this job failed (ChatGPT surface lost)");
});

test("a worker that never finishes fails after the attempt budget and a hung one is killed at the timeout", async () => {
  const dir = temp();
  const failing = fakeCodex(dir, `process.stdin.on("data", () => {}); process.stdin.on("end", () => { console.log(JSON.stringify({ type: "turn.failed", error: { message: "nope" } })); process.exit(1); });`);
  const failed = await runWorker({ cwd: dir, brief: "x", timeoutMs: 20_000, attempts: 2, codex: failing, ...BASE });
  expect(failed).toMatchObject({ ok: false, attempts: 2, failure: "nope" });
  expect(formatWorkerResult(failed)).toContain("WORKER FAILED after 2 attempts: nope");
  const hung = fakeCodex(dir, `process.stdin.on("data", () => {}); setInterval(() => {}, 1000);`);
  const started = Date.now();
  const timedOut = await runWorker({ cwd: dir, brief: "x", timeoutMs: 1_500, attempts: 1, codex: hung, ...BASE });
  expect(timedOut).toMatchObject({ ok: false, failure: "the worker ran out of time" });
  expect(Date.now() - started).toBeLessThan(15_000);
});

test("findCodex honours the override and the command line is quoted for the shell Codex uses", () => {
  expect(findCodex({ CODEX_WORKER_CODEX: "C:/codex/codex.exe" })).toEqual({ exe: "C:/codex/codex.exe", args: [] });
  expect(findCodex({ LOCALAPPDATA: join(tmpdir(), "no-such-folder") })).toEqual({ exe: "codex", args: [] });
  expect(workerCommandLine(["C:/a b/bun.exe", "C:/a b/cli.js"], "C:/h", "win32"))
    .toBe("& 'C:/a b/bun.exe' 'C:/a b/cli.js' '--home' 'C:/h' 'worker' 'run'");
  expect(workerCommandLine(["/opt/it's/bun", "/opt/cli.js"], "/home/u", "linux"))
    .toBe(`'/opt/it'\\''s/bun' '/opt/cli.js' '--home' '/home/u' 'worker' 'run'`);
});
