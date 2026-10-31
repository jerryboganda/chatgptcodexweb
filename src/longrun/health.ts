import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LongrunSettings } from "./settings";
import { WORKER_PROMPT_START } from "./worker";
import { describeWorker, type WorkerLock } from "./worker-lock";

/**
 * Is a long run alive? Codex writes every session to a rollout file, so the last events show whether a turn is
 * still going, ended, was interrupted, or went silent in the middle (Codex was restarted, a connection dropped).
 */
export type SessionPhase = "working" | "stalled" | "idle" | "interrupted";
export type SessionRole = "driver" | "worker" | "direct";

export interface SessionHealth {
  id: string;
  cwd: string;
  model: string;
  role: SessionRole;
  lastActivityAt: number;
  phase: SessionPhase;
}

type RoleSettings = Pick<LongrunSettings, "driverModelPrefixes" | "modelPrefixes">;

const HEAD_BYTES = 1_000_000;
const TAIL_BYTES = 512 * 1024;
/** A driver polls its worker about every half minute, so ten silent minutes mean it is gone; a worker may think for long. */
const STALL_MINUTES: Record<SessionRole, number> = { driver: 10, worker: 30, direct: 30 };
/** A worker process this old with no chat of its own is stuck before ChatGPT. */
const NO_CHAT_MINUTES = 10;
const BOUNDARIES = new Set(["task_started", "task_complete", "turn_aborted"]);

export function summarizeRollout(head: string, tail: string[], now: number, settings: RoleSettings): SessionHealth | undefined {
  let meta: { id?: unknown; cwd?: unknown } | undefined;
  let model = "";
  for (const line of head.split("\n")) {
    if (!line) continue;
    let record: { type?: string; payload?: Record<string, unknown> };
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === "session_meta" && !meta) meta = record.payload;
    else if (record.type === "turn_context" && !model) model = typeof record.payload?.model === "string" ? record.payload.model : "";
    if (meta && model) break;
  }
  if (typeof meta?.id !== "string" || !model) return undefined;
  const chatgptWeb = settings.modelPrefixes.some((prefix) => model.startsWith(prefix));
  const role: SessionRole | undefined = settings.driverModelPrefixes.some((prefix) => model.startsWith(prefix)) ? "driver"
    : chatgptWeb ? (head.includes(WORKER_PROMPT_START) ? "worker" : "direct") : undefined;
  if (!role) return undefined;

  let lastActivityAt = 0;
  let boundary = "";
  for (const line of tail) {
    let record: { timestamp?: string; type?: string; payload?: { type?: string } };
    try { record = JSON.parse(line); } catch { continue; }
    const at = Date.parse(record.timestamp ?? "");
    if (Number.isFinite(at)) lastActivityAt = Math.max(lastActivityAt, at);
    if (record.type === "event_msg" && record.payload?.type && BOUNDARIES.has(record.payload.type)) boundary = record.payload.type;
  }
  if (lastActivityAt === 0) return undefined;
  const phase: SessionPhase = boundary === "task_complete" ? "idle"
    : boundary === "turn_aborted" ? "interrupted"
      : now - lastActivityAt > STALL_MINUTES[role] * 60_000 ? "stalled" : "working";
  return { id: meta.id, cwd: typeof meta.cwd === "string" ? meta.cwd : "", model, role, lastActivityAt, phase };
}

function readRange(path: string): { head: string; tail: string[] } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const read = (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const count = readSync(fd!, buffer, 0, length, start);
      return buffer.subarray(0, count).toString("utf8");
    };
    const head = read(0, Math.min(size, HEAD_BYTES));
    const start = Math.max(0, size - TAIL_BYTES);
    const lines = read(start, size - start).split("\n");
    return { head, tail: start > 0 ? lines.slice(1) : lines };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* Nothing more to do. */ }
  }
}

/** Sessions of the newest few days of Codex history whose last event is recent. Reads only the ends of each file. */
export function scanSessions(
  codexHome: string, now: number, settings: RoleSettings, { hours = 24, days = 4 }: { hours?: number; days?: number } = {},
): SessionHealth[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];
  const names = (directory: string) => { try { return readdirSync(directory).sort().reverse(); } catch { return []; } };
  const directories: string[] = [];
  for (const year of names(root)) for (const month of names(join(root, year))) for (const day of names(join(root, year, month))) {
    if (directories.length < days) directories.push(join(root, year, month, day));
  }
  const found: SessionHealth[] = [];
  for (const directory of directories) {
    for (const name of names(directory)) {
      if (!name.endsWith(".jsonl")) continue;
      const parts = readRange(join(directory, name));
      const session = parts && summarizeRollout(parts.head, parts.tail, now, settings);
      if (session && now - session.lastActivityAt <= hours * 3_600_000) found.push(session);
    }
  }
  return found.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 90 ? `${minutes} min ago` : `${(minutes / 60).toFixed(1)} h ago`;
}

const PHASE_TEXT: Record<SessionPhase, string> = {
  working: "working", stalled: "SILENT in the middle of a turn", idle: "finished its turn", interrupted: "interrupted",
};

/** A worker or direct chat that ended without finishing was cut off (timeout, restart); that is normal, not a fault. */
function phaseText(role: SessionRole, phase: SessionPhase): string {
  return phase === "stalled" && role !== "driver" ? "ended without finishing" : PHASE_TEXT[phase];
}

/** A readable report per project: the newest driver, worker and direct chat, then what looks wrong. */
export function formatHealth(sessions: SessionHealth[], now: number, workerIn: (cwd: string) => WorkerLock | undefined): string[] {
  const projects = new Map<string, SessionHealth[]>();
  for (const session of sessions) {
    const key = session.cwd.toLowerCase();
    projects.set(key, [...(projects.get(key) ?? []), session]);
  }
  if (projects.size === 0) return ["No long-run sessions were active in the last day."];
  const lines: string[] = [];
  const problems: string[] = [];
  for (const group of projects.values()) {
    const cwd = group[0]!.cwd;
    lines.push(cwd || "(unknown folder)");
    const worker = workerIn(cwd);
    for (const role of ["driver", "worker", "direct"] as const) {
      const latest = group.find((session) => session.role === role);
      if (!latest) continue;
      lines.push(`  ${role.padEnd(7)} ${latest.model.padEnd(24)} ${phaseText(role, latest.phase)}, last activity ${ago(now - latest.lastActivityAt)}`);
      if (latest.phase === "stalled" && role === "driver") {
        problems.push(`${cwd}: the driver has been silent for ${ago(now - latest.lastActivityAt).replace(" ago", "")} in the middle of a turn. Codex was probably restarted or lost its connection. Open that chat and send a message such as "continue".`);
      }
      // Only a worker whose process still holds the folder can be stuck; a silent chat with no process just ended.
      // A chat older than the process belongs to an earlier worker, so it says nothing about this one.
      if (role === "worker" && worker) {
        if (latest.lastActivityAt >= worker.startedAt) {
          if (latest.phase === "stalled") {
            problems.push(`${cwd}: the worker's process is still running but its chat has been silent for ${ago(now - latest.lastActivityAt).replace(" ago", "")}. ChatGPT may have stopped responding; if it stays silent, end it with the worker command's \`stop\` action and send the job again.`);
          }
        } else if (now - worker.startedAt > NO_CHAT_MINUTES * 60_000) {
          problems.push(`${cwd}: the worker's process has been running for ${ago(now - worker.startedAt).replace(" ago", "")} and no worker chat has started since. It may be stuck before ChatGPT; end it with the worker command's \`stop\` action and send the job again.`);
        }
      }
      const activeChat = group.find((session) => session.role === "worker" && session.phase === "working");
      if (role === "driver" && latest.phase !== "working" && (worker || activeChat)) {
        const what = worker ? `a worker is still running (${describeWorker(worker, now)})` : `a worker may still be running (its chat was active ${ago(now - activeChat!.lastActivityAt)})`;
        problems.push(`${cwd}: ${what} but its driver is ${PHASE_TEXT[latest.phase]}. Let it finish and read .longrun/worker-report.md, or end it with the worker command's \`stop\` action before starting another job.`);
      }
    }
    if (worker) lines.push(`  worker process: ${describeWorker(worker, now)}`);
  }
  return [...lines, "", problems.length > 0 ? "Problems:" : "No problems found.", ...problems.map((problem) => `  - ${problem}`)];
}
