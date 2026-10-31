import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHealth } from "../src/longrun/health";
import {
  judgeDrivers, launchResume, loadResumeHistory, resumeMessage, saveResumeHistory, watchdogTick, type WatchdogDeps,
} from "../src/longrun/resume";
import type { WorkerLock } from "../src/longrun/worker-lock";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "longrun-resume-"));
  cleanup.push(path);
  return path;
}

const NOW = Date.parse("2026-10-31T12:00:00Z");
const MIN = 60_000;

function driver(over: Partial<SessionHealth> = {}): SessionHealth {
  return { id: "d1", cwd: "C:\\Projects\\App", model: "gpt-6-luna", role: "driver", lastActivityAt: NOW - 30 * MIN, phase: "stalled", ...over };
}
const base = (over: Record<string, unknown> = {}) => ({
  now: NOW, sessions: [driver()], appServerStartedAt: NOW - 20 * MIN, workerIn: () => undefined, history: {}, ...over,
});
const verdictOf = (over: Record<string, unknown> = {}) => judgeDrivers(base(over) as Parameters<typeof judgeDrivers>[0])[0]!;

test("a driver that went silent before the app-server restarted is dead and is resumed", () => {
  expect(verdictOf()).toMatchObject({ resume: true });
  expect(verdictOf({ sessions: [driver({ lastActivityAt: NOW - 12 * MIN })], appServerStartedAt: NOW - 5 * MIN })).toMatchObject({ resume: true });
});

test("a driver is left alone when it may still be working, was stopped by the user or has a worker running", () => {
  expect(verdictOf({ sessions: [driver({ lastActivityAt: NOW - 11 * MIN })], appServerStartedAt: NOW - 60 * MIN })).toMatchObject({ resume: false, why: "may still be working" });
  expect(verdictOf({ sessions: [driver({ lastActivityAt: NOW - 5 * MIN })], appServerStartedAt: NOW - 2 * MIN })).toMatchObject({ resume: false });
  expect(verdictOf({ sessions: [driver({ phase: "interrupted" })] })).toMatchObject({ resume: false, why: "interrupted" });
  expect(verdictOf({ sessions: [driver({ phase: "idle" })] })).toMatchObject({ resume: false, why: "idle" });
  expect(verdictOf({ sessions: [driver({ phase: "working", lastActivityAt: NOW - 1 * MIN })] })).toMatchObject({ resume: false });
  const lock: WorkerLock = { pid: 1, cwd: "C:\\Projects\\App", startedAt: NOW - 20 * MIN, heartbeatAt: NOW, model: "m", effort: "high" };
  expect(verdictOf({ workerIn: () => lock })).toMatchObject({ resume: false, why: "its worker is still running" });
});

test("without a restart to explain the silence a driver must be silent for 90 minutes, and an abandoned one is never revived", () => {
  expect(verdictOf({ sessions: [driver({ lastActivityAt: NOW - 60 * MIN })], appServerStartedAt: undefined })).toMatchObject({ resume: false, why: "may still be working" });
  expect(verdictOf({ sessions: [driver({ lastActivityAt: NOW - 100 * MIN })], appServerStartedAt: undefined })).toMatchObject({ resume: true });
  expect(verdictOf({ sessions: [driver({ lastActivityAt: NOW - 7 * 60 * MIN })] })).toMatchObject({ resume: false, why: "silent for too long" });
});

test("only the newest driver of a folder is judged, and resumes are limited and spaced", () => {
  const older = driver({ id: "old", lastActivityAt: NOW - 50 * MIN });
  const verdicts = judgeDrivers(base({ sessions: [older, driver()] }) as Parameters<typeof judgeDrivers>[0]);
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]!.session.id).toBe("d1");
  expect(verdictOf({ history: { d1: [NOW - 5 * MIN] } })).toMatchObject({ resume: false, why: "resumed a moment ago" });
  expect(verdictOf({ history: { d1: [NOW - 20 * MIN, NOW - 40 * MIN] } })).toMatchObject({ resume: true });
  expect(verdictOf({ history: { d1: [NOW - 20 * MIN, NOW - 40 * MIN, NOW - 60 * MIN] } })).toMatchObject({ resume: false, why: "resumed too often" });
  expect(verdictOf({ history: { d1: [NOW - 20 * MIN, NOW - 40 * MIN, NOW - 7 * 60 * MIN] } })).toMatchObject({ resume: true });
});

test("the resume message says to continue, not restart, and repeats the no-tests flow", () => {
  const text = resumeMessage();
  expect(text).toContain("do not start over");
  expect(text).toContain(".longrun/PROGRESS.md");
  expect(text).toContain("do not start a second one");
  expect(text).toContain("nothing is tested or built");
  expect(text).toContain("push to main");
});

test("the history survives a round trip and garbage is ignored", () => {
  const home = temp();
  expect(loadResumeHistory(home)).toEqual({});
  saveResumeHistory({ d1: [1, 2] }, home);
  expect(loadResumeHistory(home)).toEqual({ d1: [1, 2] });
  writeFileSync(join(home, "longrun", "resumes.json"), "[1]");
  expect(loadResumeHistory(home)).toEqual({});
});

function fakeWatchdog(over: Partial<WatchdogDeps> = {}) {
  const home = over.home ?? temp();
  const log: string[] = [];
  const resumed: string[] = [];
  const deps: WatchdogDeps = {
    home, now: () => NOW, sessions: () => [driver()], appServerStartedAt: () => NOW - 20 * MIN, workerIn: () => undefined,
    resume: (session) => { resumed.push(session.id); return { started: true }; },
    log: (event) => log.push(event),
    ...over,
  };
  return { deps, log, resumed, home };
}

test("the watchdog resumes a dead driver once, records it, and does not repeat inside the cooldown", () => {
  const { deps, log, resumed, home } = fakeWatchdog();
  expect(watchdogTick(deps)).toEqual(["d1"]);
  expect(resumed).toEqual(["d1"]);
  expect(log).toContain("resume_started");
  expect(loadResumeHistory(home).d1).toEqual([NOW]);
  expect(watchdogTick(deps)).toEqual([]);
  expect(resumed).toEqual(["d1"]);
});

test("the watchdog does nothing when long-run or the driver is switched off, and never throws", () => {
  const off = fakeWatchdog();
  writeFileSync(join(off.home, "longrun.json"), JSON.stringify({ driver: false }));
  expect(watchdogTick(off.deps)).toEqual([]);
  expect(off.resumed).toEqual([]);
  const broken = fakeWatchdog({ sessions: () => { throw new Error("disk"); } });
  expect(watchdogTick(broken.deps)).toEqual([]);
  expect(broken.log).toContain("watchdog_error");
  const failing = fakeWatchdog({ resume: () => ({ started: false, reason: "no codex" }) });
  expect(watchdogTick(failing.deps)).toEqual([]);
  expect(failing.log).toContain("resume_failed");
});

test("launching a resume runs codex exec resume with the session, the model and full access, and sends the message on stdin", async () => {
  const dir = temp();
  const script = join(dir, "fake-codex.cjs");
  writeFileSync(script, `
    let input = ""; process.stdin.on("data", (c) => input += c);
    process.stdin.on("end", () => {
      require("node:fs").writeFileSync(process.cwd() + "/seen.txt", process.argv.slice(2).join(" ") + "|" + input);
      console.error("already has an active writer");
      process.exit(1);
    });`);
  const exit = await new Promise<{ code: number | null; reason: string }>((resolve) => {
    const launched = launchResume({ id: "abc-123", cwd: dir, model: "gpt-6-luna" }, "keep going", {
      codex: { exe: process.execPath, args: [script] }, onExit: (code, reason) => resolve({ code, reason }),
    });
    expect(launched.started).toBe(true);
  });
  expect(exit).toEqual({ code: 1, reason: "already has an active writer" });
  expect(existsSync(join(dir, "seen.txt"))).toBe(true);
  expect(readFileSync(join(dir, "seen.txt"), "utf8")).toBe(
    `exec resume abc-123 --skip-git-repo-check -m gpt-6-luna --dangerously-bypass-approvals-and-sandbox -|keep going`,
  );
});
