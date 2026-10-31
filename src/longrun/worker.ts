import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { saveCheckpoint } from "./checkpoint";
import { excludeOwnFiles } from "./ship";

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
  /** An attempt that produces no output at all for this long is stuck: it is cut off and retried. */
  idleMs?: number;
  /** Where what the worker does is written as it happens; default `.longrun/worker-progress.md` in the folder. */
  progressFile?: string | false;
  /** Waits between attempts; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Ten silent minutes are normal while a high-effort model thinks; twenty mean the chat or the bridge is stuck. */
export const DEFAULT_WORKER_IDLE_MINUTES = 20;

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
  /** What kind of failure ended it, so the driver can act on the cause instead of guessing. */
  failureKind?: FailureKind;
  failureAdvice?: string;
  changed: string[];
  /** Where the work of the last attempt was saved (a ref under refs/longrun/), when there was any. */
  checkpoint?: string;
  progressFile?: string;
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
  /** Cut off because it produced no output for the idle limit. */
  stalled: boolean;
  /** Cut off because it started a test, build or other forbidden command. */
  forbidden?: string;
  message: string;
  error: string;
}

export type FailureKind = "permission" | "capacity" | "unreachable" | "forbidden" | "stalled" | "timeout" | "other";

export interface FailureAdvice {
  kind: FailureKind;
  /** Worth retrying at once without spending an attempt: the cause is outside the work (a permission card, a busy ChatGPT). */
  free: boolean;
  waitMs: number;
  advice: string;
}

/** The cause of a failed attempt, from what the worker or Codex reported; used to wait the right time and to tell the driver what to fix. */
export function classifyFailure(why: string, flags: { stalled?: boolean; timedOut?: boolean; forbidden?: string } = {}): FailureAdvice {
  if (flags.forbidden) {
    return { kind: "forbidden", free: false, waitMs: 5_000, advice: "The worker started a test, build or package script, which is not allowed here. The retry brief forbids it again." };
  }
  if (/permission|approval|approve|not allowed to use|allow (?:once|all)/i.test(why) && /plugin|connector|ChatGPT|Codex Native|tool/i.test(why)) {
    return { kind: "permission", free: true, waitMs: 20_000, advice: "ChatGPT asked for a tool permission that was not approved in time. Retry; if it keeps happening, set the plugin's Permissions to Allow all actions in ChatGPT (see TROUBLESHOOTING.md)." };
  }
  if (/at capacity|too many requests|rate.?limit|\b429\b|try again later|overloaded|usage limit/i.test(why)) {
    return { kind: "capacity", free: true, waitMs: 5 * 60_000, advice: "ChatGPT is busy or rate limited. Waiting and retrying is the fix; nothing in the project is wrong." };
  }
  if (/did not become ready|ECONNREFUSED|ECONNRESET|fetch failed|connection refused|could not reach|bridge|\b50[234]\b|requires the incoming|could not start Codex|ENOENT/i.test(why)) {
    return { kind: "unreachable", free: true, waitMs: 60_000, advice: "The ChatGPT bridge or browser is not answering. Run `codex-chatgpt-web longrun health`; the launcher may need to be restarted." };
  }
  if (flags.stalled) return { kind: "stalled", free: false, waitMs: 10_000, advice: "The worker went silent, so its chat was dropped. Its files and progress notes are kept; the retry continues from them." };
  if (flags.timedOut) return { kind: "timeout", free: false, waitMs: 10_000, advice: "The slice was too big for one attempt. Split it into smaller slices." };
  return { kind: "other", free: false, waitMs: 10_000, advice: "Read the failure above; the files and progress notes are kept." };
}

const FREE_RETRIES = 6;

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
  "Work in this order: explore the code that matters, plan briefly, then make the change. Read and search files, edit files, and use read-only git commands.",
  "Do NOT run tests, builds, linters, type checkers, dev servers or package scripts of any kind (npm, npx, pnpm, yarn, bun, pip, pytest, cargo, go, dotnet, make, tsc, vitest, jest). Nothing is checked on this PC: the work is checked by GitHub Actions after it is pushed. A run that starts one of these commands is stopped.",
  "Do not commit or push; the driver does that when all the slices are done.",
  "You have full access to this PC, the network included.",
  "If the job needs something nobody on this PC can provide (a credential, an account or server you cannot reach, a decision that is the user's), do not build workarounds: finish whatever does not need it and put a line starting with `BLOCKED:` in your final report that says exactly what is missing.",
  "Report what you changed, what you checked and the result, in a few lines.",
].join("\n");

export function withWorkerRules(brief: string): string {
  return `${WORKER_RULES}\n\n---\n\n${brief}`;
}

/**
 * True for the first prompt of a `worker run` session. The driver reads a worker's work and ships it,
 * so the Stop hook must not also send the worker round that loop: it burned a whole-suite run on every stop and kept
 * workers going for dozens of continuations.
 */
export const WORKER_PROMPT_START = WORKER_RULES.split("\n")[0]!;

export function isWorkerPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(WORKER_PROMPT_START);
}

/** A command that runs a project's tests, build, linter or scripts: the worker is never to run one. */
const FORBIDDEN_COMMAND = /(?:^|[;&|(]\s*|&&\s*|-Command\s+["']?|-c\s+["']?|cmd(?:\.exe)?\s+\/c\s+["']?)(?:npm|npx|pnpm|yarn|bun|bunx)\s+(?:run\s+|x\s+|exec\s+)?(?:test|build|lint|check|typecheck|dev|start|vitest|jest|tsc|playwright|install|ci|i)\b|(?:^|[;&|(]\s*|&&\s*|-Command\s+["']?|-c\s+["']?)(?:pytest|vitest|jest|tsc|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|make\s+(?:test|check|build)|gradle\w*\s+(?:test|build)|mvn\w*\s+(?:test|package|verify)|python\w*\s+-m\s+(?:pytest|unittest))\b/i;

export function forbiddenCommand(command: string): boolean {
  return FORBIDDEN_COMMAND.test(command.trim());
}

type ExecEvent = {
  type?: string; message?: string; error?: { message?: string };
  item?: { type?: string; text?: string; command?: string; exit_code?: number | null; changes?: Array<{ path?: string; kind?: string }> };
};

/** One short line for the progress file: what the worker said, ran or changed. */
export function progressLine(event: ExecEvent): string | undefined {
  const item = event.item;
  if (event.type !== "item.completed" || !item) return undefined;
  if (item.type === "agent_message" && typeof item.text === "string") return `- said: ${item.text.trim().replace(/\s+/g, " ").slice(0, 500)}`;
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    const paths = item.changes.map((change) => change.path).filter((path): path is string => typeof path === "string");
    return paths.length > 0 ? `- changed: ${paths.slice(0, 12).join(", ")}` : undefined;
  }
  if (item.type === "command_execution" && typeof item.command === "string") return `- ran: ${item.command.trim().replace(/\s+/g, " ").slice(0, 160)}`;
  return undefined;
}

/** Codex's own log lines on stderr (`2026-10-30T17:35:15Z  WARN ...`) say nothing about why a worker failed. */
const LOG_NOISE = /websocket|Reading additional input|^\S+Z\s+(?:TRACE|DEBUG|INFO|WARN)\b/i;

export function stderrReason(stderr: string, exitCode: number | null): string {
  const lines = stderr.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !LOG_NOISE.test(line));
  return lines.slice(-3).join(" ") || `the worker exited with code ${exitCode ?? "none"} before it finished`;
}

const PREVIOUS_REPORT_LIMIT = 1500;

/**
 * The brief of a retry: a fresh chat knows nothing, so it is told what failed, what the last attempt reported or did
 * (the progress notes) and which files already changed, so it continues instead of starting over.
 */
export function retryBrief(original: string, why: string, previousReport: string, saved: { progress?: string; changed?: string[] } = {}): string {
  const report = previousReport.trim();
  const progress = saved.progress?.trim() ?? "";
  const lines = [
    `${original}\n\n---`,
    `A previous worker attempt on this job failed (${why.slice(0, 300)}). Its work is saved: the files in the folder already hold part of it. Look at the changed files first and continue from there; do not start over.`,
  ];
  if (saved.changed && saved.changed.length > 0) lines.push(`Files changed so far:\n${saved.changed.slice(0, 30).join("\n")}`);
  const what = report || progress;
  if (what) lines.push(`${report ? "What that attempt last reported" : "What that attempt did, in order"}:\n${what.length > PREVIOUS_REPORT_LIMIT ? `…${what.slice(-PREVIOUS_REPORT_LIMIT)}` : what}`);
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

function runAttempt(options: WorkerOptions, brief: string, attempt: number): Promise<Attempt> {
  const codex = options.codex ?? findCodex();
  const args = [
    ...codex.args, "exec", "--json", "--skip-git-repo-check",
    "-m", options.model, "-c", `model_reasoning_effort="${options.effort}"`,
    // The worker gets every permission: no sandbox and no approval prompts, so nothing it needs is refused.
    "-s", "danger-full-access", "-c", 'approval_policy="never"', "-",
  ];
  const progress = progressPath(options);
  const note = (line: string) => {
    if (!progress) return;
    try { appendFileSync(progress, `${line}\n`); } catch { /* the notes are a safety net, never a reason to fail */ }
  };
  note(`\n## Attempt ${attempt} (${new Date().toISOString()})`);
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let stalled = false;
    let forbidden: string | undefined;
    let settled = false;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let child;
    try {
      child = spawn(codex.exe, args, { cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ completed: false, exitCode: null, timedOut: false, stalled: false, message: "", error: `could not start Codex: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      if (heartbeat) clearInterval(heartbeat);
      if (buffer.trim()) lines.push(buffer);
      const parsed = parseWorkerEvents(lines);
      resolve({
        ...parsed, exitCode, timedOut, stalled, forbidden,
        error: parsed.error
          || (forbidden ? `the worker started a forbidden command (${forbidden.slice(0, 120)})` : "")
          || (stalled ? `the worker produced no output for ${Math.max(1, Math.ceil((options.idleMs ?? DEFAULT_WORKER_IDLE_MINUTES * 60_000) / 60_000))} minutes` : "")
          || (timedOut ? "the worker ran out of time" : parsed.completed ? "" : stderrReason(stderr, exitCode)),
      });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, options.timeoutMs);
    const idleMs = options.idleMs ?? DEFAULT_WORKER_IDLE_MINUTES * 60_000;
    const watchdog = setInterval(() => {
      if (idleMs > 0 && Date.now() - lastOutputAt > idleMs) { stalled = true; killTree(child.pid); }
    }, Math.min(30_000, Math.max(50, Math.floor(idleMs / 4) || 30_000)));
    const heartbeat = options.heartbeatMs && options.log
      ? setInterval(() => options.log!(`worker still running (${Math.round((Date.now() - startedAt) / 60_000)} min)`), options.heartbeatMs)
      : undefined;
    const onLine = (line: string) => {
      lines.push(line);
      let event: ExecEvent;
      try { event = JSON.parse(line) as ExecEvent; } catch { return; }
      const said = progressLine(event);
      if (said) note(said);
      const command = event.item?.type === "command_execution" ? event.item.command : undefined;
      if (!forbidden && typeof command === "string" && event.type === "item.started" && forbiddenCommand(command)) {
        forbidden = command;
        note(`- STOPPED: started a forbidden command: ${command.trim().replace(/\s+/g, " ").slice(0, 160)}`);
        killTree(child.pid);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      buffer += chunk.toString("utf8");
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    });
    child.stderr.on("data", (chunk: Buffer) => { lastOutputAt = Date.now(); stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => { /* the worker may exit before reading everything */ });
    child.stdin.end(brief);
  });
}

function progressPath(options: WorkerOptions): string | undefined {
  if (options.progressFile === false) return undefined;
  const file = options.progressFile ?? join(options.cwd, ".longrun", "worker-progress.md");
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    return file;
  } catch {
    return undefined;
  }
}

function readProgress(file: string | undefined, attemptsFrom: number): string {
  if (!file) return "";
  try {
    const text = readFileSync(file, "utf8");
    const at = text.lastIndexOf(`## Attempt ${attemptsFrom} `);
    return at >= 0 ? text.slice(at).split("\n").slice(1).join("\n") : "";
  } catch {
    return "";
  }
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
 * chat that broke or filled up never carries into the retry. What an attempt did is written to the progress file as it
 * happens and its files are saved as a checkpoint when it ends, so a failure never loses the work; the retry brief
 * says what went wrong and where the work stands. A failure whose cause lies outside the work (a permission card,
 * a busy ChatGPT, a bridge that is down) waits and retries without spending one of the attempts.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  excludeOwnFiles(options.cwd);
  const progress = progressPath(options);
  let brief = options.brief;
  let last: Attempt | undefined;
  let advice: FailureAdvice | undefined;
  let checkpoint: string | undefined;
  let spent = 0;
  let free = 0;
  let run = 0;
  while (spent < options.attempts) {
    run += 1;
    options.log?.(`worker attempt ${run} (${spent + 1} of ${options.attempts}; ${options.model}, ${options.effort})`);
    last = await runAttempt(options, withWorkerRules(brief), run);
    checkpoint = saveCheckpoint(options.cwd, `worker attempt ${run}`) ?? checkpoint;
    if (checkpoint) options.log?.(`work saved as ${checkpoint}`);
    if (last.completed && last.exitCode === 0 && !last.timedOut && !last.stalled && !last.forbidden) {
      return { ok: true, attempts: run, message: last.message, changed: changedFiles(options.cwd), checkpoint, progressFile: progress };
    }
    const why = last.error || (last.timedOut ? "the worker ran out of time" : `the worker exited with code ${last.exitCode ?? "none"}`);
    advice = classifyFailure(why, { stalled: last.stalled, timedOut: last.timedOut, forbidden: last.forbidden });
    options.log?.(`worker attempt ${run} failed (${advice.kind}): ${why}`);
    const saved = { progress: readProgress(progress, run), changed: changedFiles(options.cwd) };
    brief = retryBrief(options.brief, why, last.message, saved);
    if (advice.kind === "forbidden") brief += "\n\nThe previous attempt was stopped because it ran a test, build or package script. Do not run any; only read, plan and edit files.";
    if (advice.free && free < FREE_RETRIES) {
      free += 1;
      options.log?.(`${advice.advice} Waiting ${Math.round(advice.waitMs / 1000)} s, then retrying without using an attempt.`);
      await sleep(advice.waitMs);
      continue;
    }
    spent += 1;
    if (spent < options.attempts) await sleep(advice.waitMs);
  }
  return {
    ok: false,
    attempts: run,
    message: last?.message ?? "",
    failure: last?.error || (last?.timedOut ? "the worker ran out of time" : "the worker did not finish"),
    failureKind: advice?.kind,
    failureAdvice: advice?.advice,
    changed: changedFiles(options.cwd),
    checkpoint,
    progressFile: progress,
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
    result.checkpoint ? `\nThe work is saved as ${result.checkpoint} (inspect with \`git diff ${result.checkpoint}\`).` : "",
    result.progressFile ? `What the worker did, step by step: ${result.progressFile}` : "",
    blocked.length > 0
      ? "\nThe worker hit a blocker it cannot clear. Clear it yourself (network, install, environment, credentials) or record it under \"manual steps\" in PROGRESS.md; do not send the same blocker to another worker."
      : "",
    !result.ok && result.failureKind ? `\nCause (${result.failureKind}): ${result.failureAdvice ?? ""}` : "",
    result.ok
      ? "\nRead the diff yourself. Do not run tests or builds; the work is checked by GitHub Actions after it is pushed."
      : "\nThe files are kept. Start a new worker whose brief continues from them and from the progress notes, or say so in your answer.",
  ].filter(Boolean).join("\n");
}
