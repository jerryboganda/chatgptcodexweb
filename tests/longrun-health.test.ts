import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHealth, scanSessions, summarizeRollout } from "../src/longrun/health";
import { normalizeSettings } from "../src/longrun/settings";
import { WORKER_PROMPT_START } from "../src/longrun/worker";
import { acquireWorkerLock, describeWorker, liveWorker, stopWorker, waitForWorker, workerLockPath, type HeldWorkerLock, type WorkerLock } from "../src/longrun/worker-lock";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "longrun-health-"));
  cleanup.push(path);
  return path;
}

const INFO = { cwd: "C:/Projects/App", model: "chatgpt-web/gpt-6-sol", effort: "xhigh" };

function hold(home: string, now?: number): HeldWorkerLock {
  const held = acquireWorkerLock(INFO, home, now);
  if ("busy" in held) throw new Error("the folder was already held");
  return held;
}

// ---- one worker per folder

test("a second worker in the same folder is refused until the first is released, other folders are independent", () => {
  const home = temp();
  const first = hold(home);
  expect(acquireWorkerLock(INFO, home)).toMatchObject({ busy: { pid: process.pid, model: "chatgpt-web/gpt-6-sol" } });
  expect("busy" in acquireWorkerLock({ ...INFO, cwd: "C:/Projects/Other" }, home)).toBe(false);
  expect(workerLockPath("C:/Projects/App/", home)).toBe(workerLockPath("c:/projects/app", home));
  first.release();
  expect(liveWorker(INFO.cwd, home)).toBeUndefined();
  expect("busy" in acquireWorkerLock(INFO, home)).toBe(false);
});

test("a lock of a dead process or with an old heartbeat is taken over, a heartbeat keeps a lock alive", () => {
  const home = temp();
  const now = Date.now();
  const held = hold(home, now);
  expect("busy" in acquireWorkerLock(INFO, home, now + 60_000, () => true)).toBe(true);
  expect("busy" in acquireWorkerLock(INFO, home, now + 60_000, () => false)).toBe(false);
  rmSync(workerLockPath(INFO.cwd, home), { force: true });
  const again = hold(home, now);
  expect("busy" in acquireWorkerLock(INFO, home, now + 6 * 60_000, () => true)).toBe(false);
  rmSync(workerLockPath(INFO.cwd, home), { force: true });
  const last = hold(home, now - 10 * 60_000);
  last.beat();
  expect(liveWorker(INFO.cwd, home, Date.now() + 4 * 60_000, () => true)).toBeDefined();
  expect(liveWorker(INFO.cwd, home, Date.now() + 6 * 60_000, () => true)).toBeUndefined();
  expect(held.lock.pid).toBe(again.lock.pid);
});

test("stopping a worker kills its process tree and frees the folder, and release leaves another worker's lock alone", () => {
  const home = temp();
  const held = hold(home);
  const killed: number[] = [];
  expect(stopWorker(INFO.cwd, home, (pid) => killed.push(pid))?.pid).toBe(process.pid);
  expect(killed).toEqual([process.pid]);
  expect(existsSync(workerLockPath(INFO.cwd, home))).toBe(false);
  expect(stopWorker(INFO.cwd, home, (pid) => killed.push(pid))).toBeUndefined();
  mkdirSync(join(home, "longrun", "workers"), { recursive: true });
  writeFileSync(workerLockPath(INFO.cwd, home), JSON.stringify({ pid: process.pid + 100000, startedAt: Date.now(), heartbeatAt: Date.now() }));
  held.release();
  expect(existsSync(workerLockPath(INFO.cwd, home))).toBe(true);
});

test("waiting for a worker returns when it is released and gives up after the limit", async () => {
  const home = temp();
  const held = hold(home);
  expect(await waitForWorker(INFO.cwd, home, 120, 30)).toMatchObject({ pid: process.pid });
  setTimeout(() => held.release(), 100);
  expect(await waitForWorker(INFO.cwd, home, 5000, 30)).toBeUndefined();
  expect(describeWorker({ pid: 7, cwd: "", startedAt: 0, heartbeatAt: 0, model: "chatgpt-web/gpt-6-sol", effort: "xhigh" }, 12 * 60_000))
    .toBe("started 12 min ago, pid 7, chatgpt-web/gpt-6-sol at xhigh");
});

// ---- are the long runs alive?

const SETTINGS = normalizeSettings({});
const NOW = Date.parse("2026-10-31T02:40:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const meta = (id: string, cwd: string, minutesAgo = 900) => JSON.stringify({ timestamp: at(minutesAgo), type: "session_meta", payload: { id, cwd } });
const context = (model: string, minutesAgo = 899) => JSON.stringify({ timestamp: at(minutesAgo), type: "turn_context", payload: { model } });
const event = (minutesAgo: number, type: string) => JSON.stringify({ timestamp: at(minutesAgo), type: "event_msg", payload: { type } });

test("a session is working, finished, interrupted or silent depending on its last turn event and age", () => {
  const head = `${meta("s1", "C:\\p")}\n${context("gpt-6-luna")}\n`;
  const phase = (tail: string[]) => summarizeRollout(head, tail, NOW, SETTINGS)?.phase;
  expect(phase([event(30, "task_started"), event(2, "token_count")])).toBe("working");
  expect(phase([event(30, "task_started"), event(15, "token_count")])).toBe("stalled");
  expect(phase([event(30, "task_started"), event(3, "task_complete")])).toBe("idle");
  expect(phase([event(30, "task_started"), event(3, "turn_aborted")])).toBe("interrupted");
  expect(phase(["not json", event(1, "token_count")])).toBe("working");
  expect(phase([])).toBeUndefined();
});

test("the role comes from the model, a worker chat from its first prompt, and other models are ignored", () => {
  const tail = [event(1, "token_count")];
  expect(summarizeRollout(`${meta("a", "C:\\p")}\n${context("gpt-6-luna")}\n`, tail, NOW, SETTINGS)).toMatchObject({ role: "driver", cwd: "C:\\p" });
  expect(summarizeRollout(`${meta("b", "C:\\p")}\n${context("chatgpt-web/gpt-6-sol")}\n${WORKER_PROMPT_START} Do the job`, tail, NOW, SETTINGS)?.role).toBe("worker");
  expect(summarizeRollout(`${meta("c", "C:\\p")}\n${context("chatgpt-web/gpt-6-sol")}\nhello`, tail, NOW, SETTINGS)?.role).toBe("direct");
  expect(summarizeRollout(`${meta("d", "C:\\p")}\n${context("gpt-5-codex")}\n`, tail, NOW, SETTINGS)).toBeUndefined();
  expect(summarizeRollout("garbage", tail, NOW, SETTINGS)).toBeUndefined();
  const slow = [event(20, "token_count")];
  expect(summarizeRollout(`${meta("e", "C:\\p")}\n${context("chatgpt-web/gpt-6-sol")}\n${WORKER_PROMPT_START}`, slow, NOW, SETTINGS)?.phase).toBe("working");
  expect(summarizeRollout(`${meta("f", "C:\\p")}\n${context("gpt-6-luna")}\n`, slow, NOW, SETTINGS)?.phase).toBe("stalled");
});

function writeRollout(codexHome: string, day: string, name: string, lines: string[]): void {
  const directory = join(codexHome, "sessions", ...day.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `rollout-${name}.jsonl`), `${lines.join("\n")}\n`);
}

test("scanning reads the newest days, keeps recent sessions only and lists the latest first", () => {
  const codexHome = temp();
  writeRollout(codexHome, "2026/10/30", "recent-driver", [meta("driver", "C:\\Projects\\App"), context("gpt-6-luna"), event(30, "task_started"), event(20, "token_count")]);
  writeRollout(codexHome, "2026/10/31", "worker", [meta("worker", "C:\\Projects\\App"), context("chatgpt-web/gpt-6-sol"), WORKER_PROMPT_START, event(5, "token_count")]);
  writeRollout(codexHome, "2026/10/20", "old", [meta("old", "C:\\Projects\\Old", 60 * 24 * 11), context("gpt-6-luna", 60 * 24 * 11), event(60 * 24 * 10, "task_complete")]);
  writeRollout(codexHome, "2026/10/29", "ancient", [meta("ancient", "C:\\Projects\\Old", 60 * 24 * 3), context("gpt-6-luna", 60 * 24 * 3), event(60 * 24 * 2, "task_complete")]);
  expect(scanSessions(codexHome, NOW, SETTINGS, { hours: 24 }).map((session) => session.id)).toEqual(["worker", "driver"]);
  expect(scanSessions(codexHome, NOW, SETTINGS, { hours: 100 }).map((session) => session.id)).toEqual(["worker", "driver", "ancient"]);
  expect(scanSessions(join(codexHome, "missing"), NOW, SETTINGS)).toEqual([]);
});

test("the report says when a driver went silent or a worker outlived its driver, and when all is well", () => {
  const driver = (phase: "stalled" | "interrupted" | "working") => ({ id: "d", cwd: "C:\\Projects\\App", model: "gpt-6-luna", role: "driver" as const, lastActivityAt: NOW - 214 * 60_000, phase });
  const running: WorkerLock = { pid: 31128, cwd: "C:\\Projects\\App", startedAt: NOW - 41 * 60_000, heartbeatAt: NOW, model: "chatgpt-web/gpt-6-sol", effort: "xhigh" };
  const silent = formatHealth([driver("stalled")], NOW, () => undefined).join("\n");
  expect(silent).toContain("SILENT in the middle of a turn");
  expect(silent).toContain('send a message such as "continue"');
  const orphan = formatHealth([driver("interrupted")], NOW, () => running).join("\n");
  expect(orphan).toContain("a worker is still running (started 41 min ago, pid 31128");
  expect(orphan).toContain("`stop`");
  const fine = formatHealth([{ ...driver("working"), lastActivityAt: NOW - 60_000 }], NOW, () => running).join("\n");
  expect(fine).toContain("No problems found.");
  expect(fine).toContain("worker process:");
  expect(formatHealth([], NOW, () => undefined)).toEqual(["No long-run sessions were active in the last day."]);
});

test("a silent worker or direct chat without a worker process is shown as ended, not reported as a problem", () => {
  const base = { id: "w", cwd: "C:\Projects\App", model: "chatgpt-web/gpt-6-sol", lastActivityAt: NOW - 120 * 60_000, phase: "stalled" as const };
  const quiet = formatHealth([{ ...base, role: "worker" }, { ...base, id: "x", role: "direct" }], NOW, () => undefined).join("\n");
  expect(quiet).toContain("ended without finishing");
  expect(quiet).toContain("No problems found.");
  const running: WorkerLock = { pid: 9, cwd: "C:\Projects\App", startedAt: NOW - 150 * 60_000, heartbeatAt: NOW, model: "", effort: "" };
  expect(formatHealth([{ ...base, role: "worker" }], NOW, () => running).join("\n")).toContain("the worker's process is still running but its chat has been silent");
});

test("a driver that stopped while a worker chat is still active is reported even before any lock exists", () => {
  const driver = { id: "d", cwd: "C:\Projects\App", model: "gpt-6-luna", role: "driver" as const, lastActivityAt: NOW - 17 * 60_000, phase: "interrupted" as const };
  const worker = { id: "w", cwd: "C:\Projects\App", model: "chatgpt-web/gpt-6-sol", role: "worker" as const, lastActivityAt: NOW - 14 * 60_000, phase: "working" as const };
  const text = formatHealth([driver, worker], NOW, () => undefined).join("\n");
  expect(text).toContain("a worker may still be running (its chat was active 14 min ago) but its driver is interrupted");
  expect(formatHealth([driver, { ...worker, phase: "idle" }], NOW, () => undefined).join("\n")).toContain("No problems found.");
});

test("a worker process younger than its predecessor's chat is not reported, an old one with no chat of its own is", () => {
  const oldChat = { id: "w", cwd: "C:\Projects\App", model: "chatgpt-web/gpt-6-sol", role: "worker" as const, lastActivityAt: NOW - 200 * 60_000, phase: "stalled" as const };
  const fresh: WorkerLock = { pid: 9, cwd: "C:\Projects\App", startedAt: NOW - 30_000, heartbeatAt: NOW, model: "", effort: "" };
  expect(formatHealth([oldChat], NOW, () => fresh).join("\n")).toContain("No problems found.");
  const stuck = { ...fresh, startedAt: NOW - 25 * 60_000 };
  expect(formatHealth([oldChat], NOW, () => stuck).join("\n")).toContain("no worker chat has started since");
  const own = { ...oldChat, lastActivityAt: NOW - 40 * 60_000 };
  expect(formatHealth([own], NOW, () => ({ ...fresh, startedAt: NOW - 100 * 60_000 })).join("\n")).toContain("its chat has been silent for");
});
