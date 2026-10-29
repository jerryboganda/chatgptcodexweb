import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { longrunDirectory } from "./settings";

/** What the hooks remember about one Codex session between turns. */
export interface LongrunSessionState {
  version: 1;
  sessionId: string;
  /** When the current user request started. */
  taskStartedAt: number;
  /** Work-tree fingerprint when the request started (or after the last acceptance run). */
  baseline: string;
  /** Automatic continuations spent on this request. */
  continuations: number;
  lastFailureSignature?: string;
  /** Consecutive failures with the same signature and no edits in between. */
  sameFailure: number;
  /** The loop ended for this request (budget used up or stuck); stay quiet until the next request. */
  gaveUp: boolean;
  /** The "no acceptance command" hint was already shown for this session. */
  hintShown: boolean;
  updatedAt: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{6,128}$/;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function stateDirectory(home = getConfigDir()): string {
  return join(longrunDirectory(home), "state");
}

function statePath(sessionId: string, home: string): string {
  return join(stateDirectory(home), `${sessionId}.json`);
}

export function freshState(sessionId: string, baseline: string, now: number): LongrunSessionState {
  return {
    version: 1, sessionId, taskStartedAt: now, baseline, continuations: 0, sameFailure: 0, gaveUp: false, hintShown: false, updatedAt: now,
  };
}

export function loadState(sessionId: string, home = getConfigDir()): LongrunSessionState | undefined {
  if (!validSessionId(sessionId)) return undefined;
  try {
    const value = JSON.parse(readFileSync(statePath(sessionId, home), "utf8")) as Partial<LongrunSessionState>;
    if (value.version !== 1 || value.sessionId !== sessionId || typeof value.baseline !== "string") return undefined;
    return {
      ...freshState(sessionId, value.baseline, Number(value.taskStartedAt) || Date.now()),
      ...value,
      continuations: Math.max(0, Math.round(Number(value.continuations) || 0)),
      sameFailure: Math.max(0, Math.round(Number(value.sameFailure) || 0)),
      gaveUp: value.gaveUp === true,
      hintShown: value.hintShown === true,
    };
  } catch {
    return undefined;
  }
}

export function saveState(state: LongrunSessionState, home = getConfigDir()): void {
  if (!validSessionId(state.sessionId)) return;
  mkdirSync(stateDirectory(home), { recursive: true });
  atomicWriteFile(statePath(state.sessionId, home), `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`, { protectDirectory: false });
}

/** Drop state files of sessions that have been idle for two weeks. Cheap and bounded. */
export function pruneStates(home = getConfigDir(), now = Date.now(), limit = 50): number {
  const directory = stateDirectory(home);
  if (!existsSync(directory)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(directory)) {
      if (removed >= limit) break;
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      try {
        if (now - statSync(path).mtimeMs > KEEP_MS) { rmSync(path, { force: true }); removed += 1; }
      } catch { /* A file that vanished is already pruned. */ }
    }
  } catch { /* Pruning is best effort. */ }
  return removed;
}
