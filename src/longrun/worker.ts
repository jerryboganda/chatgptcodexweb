import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CodexLauncher {
  exe: string;
  args: string[];
}

export interface WorkerOptions {
  cwd: string;
  brief: string;
  model: string;
  effort: string;
  timeoutMs: number;
  attempts: number;
  codex?: CodexLauncher;
  /** Progress line every this many ms while a worker runs; 0 disables. */
  heartbeatMs?: number;
  log?: (line: string) => void;
}

/**
 * One attempt's time limit. An attempt that hits it is cut off and its chat is lost, so a slice should end well before;
 * the next attempt starts from the files and the last report. Ninety minutes let one oversized job eat three of them.
 */
export const DEFAULT_WORKER_TIMEOUT_MINUTES = 60;

export interface WorkerResult {
  ok: boolean;
  attempts: number;
  message: string;
  failure?: string;
  changed: string[];
}

/** The newest Codex desktop binary, an explicit override, or `codex` from PATH. */
export function findCodex(env: Record<string, string | undefined> = process.env): CodexLauncher {
  const override = env.CODEX_WORKER_CODEX?.trim() || env.LONGRUN_CODEX?.trim();
  if (override) return { exe: override, args: [] };
  const root = join(env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  try {
    if (existsSync(root)) {
      const found = readdirSync(root)
        .map((name) => join(root, name, "codex.exe"))
        .filter((path) => existsSync(path))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (found[0]) return { exe: found[0], args: [] };
    }
  } catch { /* fall through to PATH */ }
  return { exe: "codex", args: [] };
}

interface Attempt {
  completed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  message: string;
  error: string;
}

/** Reconnect and compaction notices are normal; anything else in an error event is a real failure. */
const TRANSIENT_ERROR = /^(?:Reconnecting|Re-connecting)/i;

export function parseWorkerEvents(lines: string[]): Pick<Attempt, "completed" | "message" | "error"> {
  let completed = false;
  let message = "";
  let error = "";
  for (const line of lines) {
    let event: { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      message = event.item.text;
    } else if (event.type === "turn.completed") {
      completed = true;
    } else if (event.type === "turn.failed") {
      completed = false;
      error = event.error?.message ?? "the worker turn failed";
    } else if (event.type === "error" && typeof event.message === "string" && !TRANSIENT_ERROR.test(event.message)) {
      error = event.message;
    }
  }
  return { completed, message, error };
}

/**
 * Put before every brief. The worker has full access, network included, so it installs what its slice needs itself. What
 * nobody on this PC can provide (a credential, an account, a server) used to burn an hour on workarounds: the worker is
 * told to hand those back at once.
 */
export const WORKER_RULES = [
  "You are a coding worker driven by another agent. Do only the one job below, which is one small slice of a larger goal.",
  "Run focused checks for the files you change; do not run the project's whole test suite or its full check pipeline, because the driver does that.",
  "You have full access to this PC, the network included: install or download what the job needs yourself.",
  "If the job needs something nobody on this PC can provide (a credential, an account or server you cannot reach, a decision that is the user's), do not build workarounds: finish whatever does not need it and put a line starting with `BLOCKED:` in your final report that says exactly what is missing.",
  "Report what you changed, what you checked and the result, in a few lines.",
].join("\n");

export function withWorkerRules(brief: string): string {
  return `${WORKER_RULES}\n\n---\n\n${brief}`;
}

/**
 * True for the first prompt of a `worker run` session. The driver checks a worker's work with the acceptance command,
 * so the Stop hook must not also send the worker round that loop: it burned a whole-suite run on every stop and kept
 * workers going for dozens of continuations.
 */
export const WORKER_PROMPT_START = WORKER_RULES.split("\n")[0]!;

export function isWorkerPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(WORKER_PROMPT_START);
}

/** Codex's own log lines on stderr (`2026-10-30T17:35:15Z  WARN ...`) say nothing about why a worker failed. */
const LOG_NOISE = /websocket|Reading additional input|^\S+Z\s+(?:TRACE|DEBUG|INFO|WARN)\b/i;

export function stderrReason(stderr: string, exitCode: number | null): string {
  const lines = stderr.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !LOG_NOISE.test(line));
  return lines.slice(-3).join(" ") || `the worker exited with code ${exitCode ?? "none"} before it finished`;
}

const PREVIOUS_REPORT_LIMIT = 1500;

/** The brief of a retry: a fresh chat knows nothing, so it is told what failed and what the last attempt reported. */
export function retryBrief(original: string, why: string, previousReport: string): string {
  const report = previousReport.trim();
  const lines = [
    `${original}\n\n---`,
    `A previous worker attempt on this job failed (${why.slice(0, 300)}). The files in the folder may already hold part of the work: look at them first and continue from there.`,
  ];
  if (report) lines.push(`What that attempt last reported:\n${report.length > PREVIOUS_REPORT_LIMIT ? `…${report.slice(-PREVIOUS_REPORT_LIMIT)}` : report}`);
  return lines.join("\n");
}

/** The `BLOCKED:` lines of a worker's report. */
export function blockedLines(message: string): string[] {
  return message.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^BLOCKED:/.test(line));
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

function runAttempt(options: WorkerOptions, brief: string): Promise<Attempt> {
  const codex = options.codex ?? findCodex();
  const args = [
    ...codex.args, "exec", "--json", "--skip-git-repo-check",
    "-m", options.model, "-c", `model_reasoning_effort="${options.effort}"`,
    // The worker gets every permission: no sandbox and no approval prompts, so nothing it needs is refused.
    "-s", "danger-full-access", "-c", 'approval_policy="never"', "-",
  ];
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(codex.exe, args, { cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ completed: false, exitCode: null, timedOut: false, message: "", error: `could not start Codex: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (buffer.trim()) lines.push(buffer);
      const parsed = parseWorkerEvents(lines);
      resolve({
        ...parsed, exitCode, timedOut,
        error: parsed.error || (timedOut ? "the worker ran out of time" : parsed.completed ? "" : stderrReason(stderr, exitCode)),
      });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, options.timeoutMs);
    const heartbeat = options.heartbeatMs && options.log
      ? setInterval(() => options.log!(`worker still running (${Math.round((Date.now() - startedAt) / 60_000)} min)`), options.heartbeatMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      lines.push(...parts);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => { /* the worker may exit before reading everything */ });
    child.stdin.end(brief);
  });
}

function changedFiles(cwd: string): string[] {
  try {
    const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (result.status !== 0) return [];
    return result.stdout.split(/\r?\n/).filter((line) => line.trim() && !/\.longrun\//.test(line)).slice(0, 60);
  } catch {
    return [];
  }
}

/**
 * Run one job on the ChatGPT web worker. Every attempt is a new `codex exec`, which is a new ChatGPT chat, so a
 * chat that broke or filled up never carries into the retry; the brief then says what went wrong.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  let brief = options.brief;
  let last: Attempt | undefined;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    options.log?.(`worker attempt ${attempt} of ${options.attempts} (${options.model}, ${options.effort})`);
    last = await runAttempt(options, withWorkerRules(brief));
    if (last.completed && last.exitCode === 0 && !last.timedOut) {
      return { ok: true, attempts: attempt, message: last.message, changed: changedFiles(options.cwd) };
    }
    const why = last.error || (last.timedOut ? "the worker ran out of time" : `the worker exited with code ${last.exitCode ?? "none"}`);
    options.log?.(`worker attempt ${attempt} failed: ${why}`);
    brief = retryBrief(options.brief, why, last.message);
  }
  return {
    ok: false,
    attempts: options.attempts,
    message: last?.message ?? "",
    failure: last?.error || (last?.timedOut ? "the worker ran out of time" : "the worker did not finish"),
    changed: changedFiles(options.cwd),
  };
}

export function formatWorkerResult(result: WorkerResult): string {
  const blocked = blockedLines(result.message);
  const head = result.ok
    ? `WORKER FINISHED (attempt ${result.attempts})`
    : `WORKER FAILED after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}: ${result.failure ?? "unknown"}`;
  return [
    head,
    result.message ? `\nWorker's report:\n${result.message.trim()}` : "",
    result.changed.length > 0 ? `\nChanged files:\n${result.changed.join("\n")}` : "\nNo changed files were detected.",
    blocked.length > 0
      ? "\nThe worker hit a blocker it cannot clear. Clear it yourself (network, install, environment, credentials) or record it under \"manual steps\" in PROGRESS.md; do not send the same blocker to another worker."
      : "",
    result.ok ? "\nCheck the work yourself: read the diff and run the acceptance command." : "\nStart a new worker with a shorter brief, or say so in your answer.",
  ].filter(Boolean).join("\n");
}
