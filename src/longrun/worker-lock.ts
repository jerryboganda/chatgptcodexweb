import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { longrunDirectory } from "./settings";
import { killTree } from "./worker";

/**
 * One worker per folder. Stopping a Luna turn does not stop the `worker run` it started, and the next turn used to
 * start a second worker on the same files. The lock names the running worker so a second one is refused instead.
 */
export interface WorkerLock {
  pid: number;
  cwd: string;
  startedAt: number;
  heartbeatAt: number;
  model: string;
  effort: string;
}

/** A lock whose heartbeat is older than this belongs to a worker that is gone, even if its pid was reused. */
const STALE_MS = 5 * 60_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function workerLockPath(cwd: string, home = getConfigDir()): string {
  const key = resolve(cwd).replace(/[\\/]+$/, "").toLowerCase();
  return join(longrunDirectory(home), "workers", `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`);
}

function readLock(path: string): WorkerLock | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerLock>;
    if (![value.pid, value.startedAt, value.heartbeatAt].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    return {
      pid: value.pid!, startedAt: value.startedAt!, heartbeatAt: value.heartbeatAt!,
      cwd: typeof value.cwd === "string" ? value.cwd : "", model: typeof value.model === "string" ? value.model : "", effort: typeof value.effort === "string" ? value.effort : "",
    };
  } catch {
    return undefined;
  }
}

/** The worker that is running in this folder right now, if any. */
export function liveWorker(cwd: string, home = getConfigDir(), now = Date.now(), alive = pidAlive): WorkerLock | undefined {
  const lock = readLock(workerLockPath(cwd, home));
  return lock && alive(lock.pid) && now - lock.heartbeatAt < STALE_MS ? lock : undefined;
}

export interface HeldWorkerLock {
  lock: WorkerLock;
  /** Refresh the heartbeat; call about once a minute while the worker runs. */
  beat: () => void;
  release: () => void;
}

export function acquireWorkerLock(
  info: { cwd: string; model: string; effort: string },
  home = getConfigDir(), now = Date.now(), alive = pidAlive,
): HeldWorkerLock | { busy: WorkerLock } {
  const path = workerLockPath(info.cwd, home);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock: WorkerLock = { pid: process.pid, cwd: resolve(info.cwd), startedAt: now, heartbeatAt: now, model: info.model, effort: info.effort };
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: "wx" });
      return {
        lock,
        beat: () => {
          try { atomicWriteFile(path, JSON.stringify({ ...lock, heartbeatAt: Date.now() }), { protectDirectory: false }); } catch { /* A missed beat is not fatal. */ }
        },
        release: () => {
          if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = liveWorker(info.cwd, home, now, alive);
    if (existing) return { busy: existing };
    rmSync(path, { force: true });
  }
  throw new Error("The worker lock could not be taken.");
}

/** Stop the worker of this folder (and everything it started). Returns the lock it found, if any. */
export function stopWorker(cwd: string, home = getConfigDir(), kill: (pid: number) => void = killTree): WorkerLock | undefined {
  const path = workerLockPath(cwd, home);
  const lock = readLock(path);
  if (!lock) return undefined;
  if (pidAlive(lock.pid)) kill(lock.pid);
  rmSync(path, { force: true });
  return lock;
}

/** Wait until no worker runs in this folder, at most `maxWaitMs`. Returns the worker that is still running, if any. */
export async function waitForWorker(cwd: string, home: string, maxWaitMs: number, pollMs = 5000): Promise<WorkerLock | undefined> {
  const deadline = Date.now() + maxWaitMs;
  let lock = liveWorker(cwd, home);
  while (lock && Date.now() < deadline) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, pollMs));
    lock = liveWorker(cwd, home);
  }
  return lock;
}

export function describeWorker(lock: WorkerLock, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - lock.startedAt) / 60_000));
  return `started ${minutes} min ago, pid ${lock.pid}${lock.model ? `, ${lock.model}${lock.effort ? ` at ${lock.effort}` : ""}` : ""}`;
}
