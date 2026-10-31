import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { getCodexHome } from "../codex-integration-shared";
import { scanSessions, type SessionHealth } from "./health";
import { appendLog } from "./hooks";
import { loadLongrunSettings, longrunDirectory } from "./settings";
import { findCodex, type CodexLauncher } from "./worker";
import { liveWorker, type WorkerLock } from "./worker-lock";

/**
 * A Luna driver whose turn was killed (the Codex app-server restarted, a connection dropped) shows a spinner and
 * never answers again. Nothing inside Codex resumes it, so this watchdog does: it finds the silent driver and sends it
 * a "continue" with `codex exec resume`, which works on an idle thread while the desktop app is open. A driver the user
 * stopped on purpose (an interrupted turn) is never touched, and a driver whose worker is still running is left alone.
 */
export const WATCHDOG_INTERVAL_MS = 2 * 60_000;
/** A driver silent this long after the app-server restarted is dead: its turn died with the old process. */
const DEAD_AFTER_RESTART_MS = 10 * 60_000;
/** Without a restart to explain it, a driver must be silent this long before it is treated as dead. */
const DEAD_WITHOUT_RESTART_MS = 90 * 60_000;
const MAX_RESUMES = 3;
const RESUME_WINDOW_MS = 6 * 3_600_000;
const COOLDOWN_MS = 15 * 60_000;
/** A driver silent for longer than this was abandoned, not cut off: reviving it could act on a task nobody wants any more. */
const ABANDONED_AFTER_MS = 6 * 3_600_000;
const reportedGaveUp = new Set<string>();

export function resumeMessage(): string {
  return [
    "Your previous turn was cut off (Codex was restarted or lost its connection), so you stopped without finishing. Continue the task from where it stopped; do not start over.",
    "Read .longrun/PROGRESS.md, `.longrun/worker-report.md` and `.longrun/worker-progress.md`, and `git status`, to see what is done and what is next. If a worker still runs in the folder, wait for it with long polls; do not start a second one.",
    "Remember the flow: nothing is tested or built here or on the server; when all slices are done, commit everything, push to main, look at the GitHub Actions run once and report it.",
  ].join(" ");
}

export interface ResumeHistory { [sessionId: string]: number[] }

function historyPath(home: string): string {
  return join(longrunDirectory(home), "resumes.json");
}

export function loadResumeHistory(home = getConfigDir()): ResumeHistory {
  try {
    const value = JSON.parse(readFileSync(historyPath(home), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const history: ResumeHistory = {};
    for (const [id, times] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(times)) history[id] = times.filter((time): time is number => typeof time === "number" && Number.isFinite(time));
    }
    return history;
  } catch {
    return {};
  }
}

export function saveResumeHistory(history: ResumeHistory, home = getConfigDir()): void {
  try {
    mkdirSync(longrunDirectory(home), { recursive: true });
    atomicWriteFile(historyPath(home), `${JSON.stringify(history)}\n`, { protectDirectory: false });
  } catch { /* the history only limits how often a resume is tried */ }
}

export interface ResumeCheck {
  now: number;
  sessions: SessionHealth[];
  /** When the Codex app-server process that is running now was started. */
  appServerStartedAt?: number;
  workerIn: (cwd: string) => WorkerLock | undefined;
  history: ResumeHistory;
}

export type ResumeVerdict = { session: SessionHealth; resume: true } | { session: SessionHealth; resume: false; why: string };

/** The newest driver of each folder, and whether it is dead and may be resumed now. */
export function judgeDrivers(check: ResumeCheck): ResumeVerdict[] {
  const newest = new Map<string, SessionHealth>();
  for (const session of check.sessions) {
    if (session.role !== "driver") continue;
    const key = session.cwd.toLowerCase();
    const current = newest.get(key);
    if (!current || session.lastActivityAt > current.lastActivityAt) newest.set(key, session);
  }
  const verdicts: ResumeVerdict[] = [];
  for (const session of newest.values()) {
    const no = (why: string): ResumeVerdict => ({ session, resume: false, why });
    if (session.phase !== "stalled") { verdicts.push(no(session.phase)); continue; }
    if (!session.cwd) { verdicts.push(no("no folder")); continue; }
    const silentFor = check.now - session.lastActivityAt;
    const restarted = check.appServerStartedAt !== undefined && check.appServerStartedAt > session.lastActivityAt;
    if (silentFor > ABANDONED_AFTER_MS) { verdicts.push(no("silent for too long")); continue; }
    if (silentFor < (restarted ? DEAD_AFTER_RESTART_MS : DEAD_WITHOUT_RESTART_MS)) { verdicts.push(no("may still be working")); continue; }
    if (check.workerIn(session.cwd)) { verdicts.push(no("its worker is still running")); continue; }
    const recent = (check.history[session.id] ?? []).filter((time) => check.now - time < RESUME_WINDOW_MS);
    if (recent.length >= MAX_RESUMES) { verdicts.push(no("resumed too often")); continue; }
    if (recent.length > 0 && check.now - Math.max(...recent) < COOLDOWN_MS) { verdicts.push(no("resumed a moment ago")); continue; }
    verdicts.push({ session, resume: true });
  }
  return verdicts;
}

/** Start time of the newest `codex app-server` process (Windows), or undefined when it cannot be read. */
export function appServerStartedAt(): number | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Where-Object { $_.CommandLine -match ' app-server' } | ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    if (result.status !== 0) return undefined;
    const times = result.stdout.split(/\r?\n/).map((line) => Date.parse(line.trim())).filter((time) => Number.isFinite(time));
    return times.length > 0 ? Math.max(...times) : undefined;
  } catch {
    return undefined;
  }
}

export interface ResumeLaunch { started: boolean; reason?: string }

/** `codex exec resume <id>`: the turn runs on in the background and its events go into the same thread. */
export function launchResume(
  session: { id: string; cwd: string; model: string }, message: string,
  options: { codex?: CodexLauncher; onExit?: (code: number | null, reason: string) => void } = {},
): ResumeLaunch {
  const codex = options.codex ?? findCodex();
  const args = [
    ...codex.args, "exec", "resume", session.id, "--skip-git-repo-check",
    "-m", session.model, "--dangerously-bypass-approvals-and-sandbox", "-",
  ];
  try {
    const cwd = existsSync(session.cwd) ? session.cwd : undefined;
    const child = spawn(codex.exe, args, { cwd, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.stdin.on("error", () => { /* the child may exit before it reads the prompt */ });
    child.stdin.end(message);
    child.on("error", (error) => options.onExit?.(null, error.message));
    child.on("close", (code) => options.onExit?.(code, stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ")));
    return { started: true };
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface WatchdogDeps {
  home: string;
  now: () => number;
  sessions: () => SessionHealth[];
  appServerStartedAt: () => number | undefined;
  workerIn: (cwd: string) => WorkerLock | undefined;
  resume: (session: SessionHealth, message: string) => ResumeLaunch;
  log: (event: string, detail?: Record<string, unknown>) => void;
}

export function defaultWatchdogDeps(home = getConfigDir()): WatchdogDeps {
  const log = (event: string, detail?: Record<string, unknown>) => appendLog(home, event, detail);
  return {
    home,
    now: () => Date.now(),
    sessions: () => {
      const settings = loadLongrunSettings(home);
      return scanSessions(getCodexHome(), Date.now(), settings, { hours: 8, days: 2 });
    },
    appServerStartedAt,
    workerIn: (cwd) => liveWorker(cwd, home),
    resume: (session, message) => launchResume(session, message, {
      onExit: (code, reason) => log("resume_exit", { session: session.id, code, reason: reason.slice(0, 200) }),
    }),
    log,
  };
}

/** One look at the drivers. Returns the ids of the sessions it resumed. Never throws. */
export function watchdogTick(deps: WatchdogDeps): string[] {
  const resumed: string[] = [];
  try {
    const settings = loadLongrunSettings(deps.home);
    if (!settings.enabled || !settings.driver) return resumed;
    const now = deps.now();
    const sessions = deps.sessions();
    if (!sessions.some((session) => session.role === "driver" && session.phase === "stalled")) return resumed;
    const history = loadResumeHistory(deps.home);
    const verdicts = judgeDrivers({ now, sessions, appServerStartedAt: deps.appServerStartedAt(), workerIn: deps.workerIn, history });
    for (const verdict of verdicts) {
      if (!verdict.resume) {
        if (verdict.why === "resumed too often" && !reportedGaveUp.has(verdict.session.id)) {
          reportedGaveUp.add(verdict.session.id);
          deps.log("resume_gave_up", { session: verdict.session.id, cwd: verdict.session.cwd });
        }
        continue;
      }
      const launched = deps.resume(verdict.session, resumeMessage());
      history[verdict.session.id] = [...(history[verdict.session.id] ?? []).filter((time) => now - time < RESUME_WINDOW_MS), now];
      deps.log(launched.started ? "resume_started" : "resume_failed", { session: verdict.session.id, cwd: verdict.session.cwd, reason: launched.reason });
      if (launched.started) resumed.push(verdict.session.id);
    }
    saveResumeHistory(history, deps.home);
  } catch (error) {
    deps.log("watchdog_error", { message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
  }
  return resumed;
}

/** Run the watchdog for as long as the bridge runs. Returns a function that stops it. */
export function startDriverWatchdog(deps: WatchdogDeps = defaultWatchdogDeps()): () => void {
  const timer = setInterval(() => { watchdogTick(deps); }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
