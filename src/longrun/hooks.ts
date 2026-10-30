import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { runAcceptance as runAcceptanceCommand, type AcceptanceResult } from "./acceptance";
import { workTreeFingerprint } from "./fingerprint";
import { resolveProject, type ProjectPlan } from "./project";
import { loadLongrunSettings, longrunDirectory, type LongrunSettings } from "./settings";
import { mayRunProjectCommands } from "./trust";
import { freshState, loadState, pruneStates, saveState, validSessionId, type LongrunSessionState } from "./state";
import { isWorkerPrompt } from "./worker";
import { describeWorker, waitForWorker, type WorkerLock } from "./worker-lock";

/** How long a driver's Stop hook waits for a worker that is still running before it sends the driver back. */
const WORKER_WAIT_MS = 20 * 60_000;

/** Marks the feedback this feature injects, so the prompt hook can tell it from a person's message. */
export const LONGRUN_MARK = "[long-run]";

/** A worker's report line that hands a blocker back to the driver; see WORKER_RULES in worker.ts. */
export const WORKER_BLOCKED = /^\s*BLOCKED:/m;

export interface StopHookInput {
  session_id?: unknown;
  cwd?: unknown;
  model?: unknown;
  agent_id?: unknown;
  stop_hook_active?: unknown;
  permission_mode?: unknown;
  last_assistant_message?: unknown;
}

export interface PromptHookInput {
  session_id?: unknown;
  cwd?: unknown;
  model?: unknown;
  agent_id?: unknown;
  prompt?: unknown;
}

/** What the hook prints. `block` makes Codex continue the same turn with `reason` as feedback. */
export type HookOutput =
  | { decision: "block"; reason: string }
  | { systemMessage: string }
  | { hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string } }
  | undefined;

/**
 * Added to every request a person sends to a Luna driver. Codex only starts agents on an explicit request and the
 * AGENTS.md block alone proved too easy to skip, so the standing request is restated with each message.
 */
export function driverContext(model: string, workerModel: string, workerEffort: string): string {
  return [
    `${LONGRUN_MARK} Your session model is ${model}: you ARE the Luna driver, so "Luna drives, Sol works" applies to you. Do not doubt this.`,
    "The user switched it on in their codex-chatgpt-web settings and wants every coding, analysis, architecture, review and investigation job done by the ChatGPT web worker",
    `(${workerModel} at ${workerEffort} effort), not by you. Only a short chat reply may stay with you.`,
    "Follow the section \"Luna drives, Sol works\" of your instructions (~/.codex/AGENTS.md): create .longrun/PROGRESS.md, write the job to .longrun/brief.md,",
    "run the worker command given there, then read the result and, for code, run the acceptance command yourself.",
    "Keep each worker job to one small slice. You do the environment, credential and full-suite work yourself, and the worker (full access, network included) writes code and runs focused checks;",
    "a blocker nobody on this PC can fix goes under \"manual steps\" in PROGRESS.md instead of being retried.",
    "This applies even when the task looks small or is only a question about the project.",
  ].join(" ");
}

export interface HookDeps {
  home: string;
  now: () => number;
  settings: () => LongrunSettings;
  project: (cwd: string) => ProjectPlan;
  fingerprint: (cwd: string) => string;
  /** May project commands run here? (a folder trusted in Codex, or a session that already runs without approvals) */
  mayRun: (cwd: string, permissionMode: unknown) => boolean;
  acceptance: (command: string, cwd: string, options: { timeoutMs: number; tailChars: number }) => Promise<AcceptanceResult>;
  /** Wait for the worker running in this folder (at most the given time); the one still running afterwards, if any. */
  waitForWorker?: (cwd: string, maxWaitMs: number) => Promise<WorkerLock | undefined>;
  log: (event: string, detail?: Record<string, unknown>) => void;
}

export function defaultDeps(home = getConfigDir()): HookDeps {
  return {
    home,
    now: () => Date.now(),
    settings: () => loadLongrunSettings(home),
    project: resolveProject,
    fingerprint: workTreeFingerprint,
    mayRun: (cwd, permissionMode) => mayRunProjectCommands(cwd, permissionMode),
    acceptance: runAcceptanceCommand,
    waitForWorker: (cwd, maxWaitMs) => waitForWorker(cwd, home, maxWaitMs),
    log: (event, detail) => appendLog(home, event, detail),
  };
}

const LOG_LIMIT_BYTES = 512 * 1024;

/** Decisions only: never prompts, messages or command output. */
export function appendLog(home: string, event: string, detail: Record<string, unknown> = {}): void {
  try {
    const directory = longrunDirectory(home);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "hook.log");
    try {
      if (existsSync(file) && statSync(file).size > LOG_LIMIT_BYTES) renameSync(file, `${file}.old`);
    } catch { /* Rotation is best effort. */ }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  } catch { /* Logging must never break a hook. */ }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function supervised(model: unknown, settings: LongrunSettings): boolean {
  const id = text(model);
  if (id.length === 0) return false;
  return settings.modelPrefixes.some((prefix) => id.startsWith(prefix)) || isDriver(model, settings);
}

/** A native Luna model that drives the task and hands the coding to a ChatGPT web worker. */
function isDriver(model: unknown, settings: LongrunSettings): boolean {
  const id = text(model);
  return settings.driver && id.length > 0 && settings.driverModelPrefixes.some((prefix) => id.startsWith(prefix));
}

/**
 * The model is waiting for a person, not stopping on its own: its last paragraph is a question.
 * Continuing would answer the question for the user, so the hook lets the turn end.
 */
export function endsWithQuestion(message: string): boolean {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1]?.trim() ?? "";
  if (/```\s*$/.test(last)) return false;
  return /[?？؟]\s*[)"'”’*_`]*\s*$/.test(last);
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/**
 * A tool the check starts is not on PATH. The hook runs the check in a plain shell, without the PATH additions and
 * environment variables the model set up in its own shell, so this is often the check's shell and not the code.
 */
export const MISSING_TOOL = /Executable not found in \$PATH|is not recognized as an internal or external command|The term '[^']+' is not recognized|: command not found|\bspawn\S* \S+ ENOENT|errno: -4058/i;

const MISSING_TOOL_HINT = [
  "This looks like a tool missing from the shell this check runs in, which is a plain shell without the PATH additions or environment variables you set up in your own shell.",
  "Run the command in your own shell: if it passes there, put that setup into a script (for example .longrun/acceptance.cmd) and make the script the acceptance command (the `acceptance:` line in AGENTS.md); if the tool really is missing, install it or record it under \"manual steps\" in PROGRESS.md.",
].join(" ");

function blockReason(options: {
  attempt: number; max: number; command: string; result: AcceptanceResult; elapsedMs: number; driver: boolean;
}): string {
  const { attempt, max, command, result } = options;
  const status = result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "none"}`;
  return [
    `${LONGRUN_MARK} The acceptance check failed, so this task is not finished yet (continuation ${attempt} of ${max}, ${minutes(options.elapsedMs)} min in).`,
    `Command: ${command}`,
    `Result: ${status}`,
    "Output (end):",
    "```",
    result.tail || "(no output)",
    "```",
    MISSING_TOOL.test(result.tail) ? MISSING_TOOL_HINT : "",
    options.driver
      ? "You are the driver: give a code fix to a worker with the worker command from your instructions, one small slice at a time, then run this command yourself. A network, install, environment or credential problem is yours to fix, or to record under \"manual steps\" in PROGRESS.md if nobody on this PC can. Do not stop until it exits with code 0."
      : "Find the cause and fix it, then check again. Do not stop until this command exits with code 0.",
    "If you are sure the check itself is wrong or you cannot go on without the user, say exactly why in your answer instead of stopping silently.",
  ].filter((line) => line !== "").join("\n");
}

/** UserPromptSubmit: a new request from the user starts a new budget and a new baseline. */
export function handlePrompt(input: PromptHookInput, deps: HookDeps): HookOutput {
  const settings = deps.settings();
  if (!settings.enabled || input.agent_id || !validSessionId(input.session_id) || !supervised(input.model, settings)) return undefined;
  const cwd = text(input.cwd);
  if (!cwd) return undefined;
  const sessionId = input.session_id;
  // Continuations injected by the Stop hook come back as prompts on some paths; they are not new requests.
  if (text(input.prompt).trimStart().startsWith(LONGRUN_MARK)) {
    if (!loadState(sessionId, deps.home)) saveState(freshState(sessionId, deps.fingerprint(cwd), deps.now()), deps.home);
    return undefined;
  }
  // A worker job is checked by the driver that started it: remember the session so its Stop hook stays out of the way.
  if (isWorkerPrompt(text(input.prompt))) {
    saveState({ ...freshState(sessionId, "worker", deps.now()), worker: true }, deps.home);
    deps.log("worker_session", { session: sessionId });
    return undefined;
  }
  const previous = loadState(sessionId, deps.home);
  const state = freshState(sessionId, deps.fingerprint(cwd), deps.now());
  state.hintShown = previous?.hintShown === true;
  // Any later prompt in a worker's session (a steering message, a resumed turn) keeps it a worker.
  if (previous?.worker) state.worker = true;
  saveState(state, deps.home);
  pruneStates(deps.home, deps.now());
  deps.log("task_started", { session: sessionId });
  if (isDriver(input.model, settings)) {
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: driverContext(text(input.model), settings.workerModel, settings.workerEffort) } };
  }
  return undefined;
}

/** Stop: if the work changed files and the acceptance check fails, send the model back to work. */
export async function handleStop(input: StopHookInput, deps: HookDeps): Promise<HookOutput> {
  const settings = deps.settings();
  if (!settings.enabled || input.agent_id || !validSessionId(input.session_id) || !supervised(input.model, settings)) return undefined;
  const cwd = text(input.cwd);
  if (!cwd) return undefined;
  const sessionId = input.session_id;
  const plan = deps.project(cwd);
  if (!plan.enabled) return undefined;

  let state = loadState(sessionId, deps.home);
  // A `worker run` session never runs the acceptance loop: the driver checks its work, and a worker held to the whole
  // check kept going for dozens of continuations and ran the full test suite on every stop.
  if (state?.worker) return undefined;
  const before = deps.fingerprint(cwd);
  if (!state) {
    // The session began before the hooks existed, so the start of this turn is unknown: begin tracking now.
    saveState(freshState(sessionId, before, deps.now()), deps.home);
    deps.log("session_adopted", { session: sessionId });
    return undefined;
  }
  if (state.gaveUp) return undefined;
  const midChain = state.continuations > 0;
  if (!midChain && before === state.baseline) return undefined;

  if (!plan.acceptance) {
    if (state.hintShown) return undefined;
    state = { ...state, hintShown: true, baseline: before };
    saveState(state, deps.home);
    deps.log("no_acceptance", { session: sessionId, root: plan.root });
    return {
      systemMessage: `${LONGRUN_MARK} I cannot tell when this task is done, so I will not keep going on my own. Add a line such as "acceptance: npm test" to AGENTS.md in the project and I will continue until that command passes.`,
    };
  }

  if (!deps.mayRun(cwd, input.permission_mode)) {
    deps.log("untrusted_project", { session: sessionId });
    if (state.hintShown) return undefined;
    saveState({ ...state, hintShown: true }, deps.home);
    return {
      systemMessage: `${LONGRUN_MARK} This folder is not trusted in Codex, so I will not run its acceptance command (${plan.acceptance.command}) on my own. Trust the folder in Codex and I will keep going until it passes.`,
    };
  }

  if (endsWithQuestion(text(input.last_assistant_message))) {
    deps.log("waiting_for_user", { session: sessionId });
    return undefined;
  }

  // A worker that names a blocker it cannot clear (network, credentials, Docker) is handed back to the driver
  // right away instead of being sent round the acceptance loop it cannot pass.
  if (!isDriver(input.model, settings) && WORKER_BLOCKED.test(text(input.last_assistant_message))) {
    deps.log("worker_blocked", { session: sessionId });
    return undefined;
  }

  const maxContinuations = Math.min(settings.maxContinuations, plan.maxContinuations ?? settings.maxContinuations);
  const elapsedMs = deps.now() - state.taskStartedAt;
  const giveUp = (why: string): HookOutput => {
    saveState({ ...state!, gaveUp: true, baseline: before }, deps.home);
    deps.log("gave_up", { session: sessionId, why, continuations: state!.continuations });
    return { systemMessage: `${LONGRUN_MARK} Stopped continuing on my own: ${why}. The acceptance command is "${plan.acceptance!.command}". Send a message to start another attempt.` };
  };
  if (state.continuations >= maxContinuations) return giveUp(`the limit of ${maxContinuations} automatic continuations was reached`);
  if (elapsedMs > settings.maxHours * 3_600_000) return giveUp(`the ${settings.maxHours} hour budget for this request is used up`);

  // A worker left running (for instance after the turn that started it was interrupted) would build in the same
  // folder as the check; wait for it, and send the driver back to it only if it outlasts the wait.
  const running = isDriver(input.model, settings) ? await deps.waitForWorker?.(cwd, WORKER_WAIT_MS) : undefined;
  if (running) {
    state = { ...state, continuations: state.continuations + 1 };
    saveState(state, deps.home);
    deps.log("worker_busy", { session: sessionId, continuation: state.continuations });
    return {
      decision: "block",
      reason: `${LONGRUN_MARK} A worker is still running in this folder (${describeWorker(running, deps.now())}), so the acceptance check was not run: it would collide with the worker's own builds. Wait for the worker command to finish and read its report in .longrun/worker-report.md, or stop it with the worker command's \`stop\` action if you no longer need it. Then finish your turn.`,
    };
  }

  const timeoutMinutes = plan.timeoutMinutes ?? settings.acceptanceTimeoutMinutes;
  const result = await deps.acceptance(plan.acceptance.command, cwd, {
    timeoutMs: Math.round(timeoutMinutes * 60_000), tailChars: settings.outputTailChars,
  });
  const after = deps.fingerprint(cwd);
  deps.log("acceptance", { session: sessionId, ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, ms: result.durationMs, continuations: state.continuations });

  if (result.ok) {
    saveState({ ...state, continuations: 0, sameFailure: 0, lastFailureSignature: undefined, baseline: after, gaveUp: false }, deps.home);
    return midChain
      ? { systemMessage: `${LONGRUN_MARK} Acceptance passed after ${state.continuations} automatic continuation${state.continuations === 1 ? "" : "s"} (${minutes(elapsedMs)} min).` }
      : undefined;
  }

  const sameFailure = result.signature === state.lastFailureSignature && before === state.baseline ? state.sameFailure + 1 : 0;
  state = { ...state, continuations: state.continuations + 1, sameFailure, lastFailureSignature: result.signature, baseline: after };
  saveState(state, deps.home);
  if (sameFailure >= settings.sameFailureLimit) {
    return giveUp(`the same failure came back ${sameFailure + 1} times with no change to the project`);
  }
  deps.log("continue", { session: sessionId, continuation: state.continuations, sameFailure });
  return {
    decision: "block",
    reason: blockReason({
      attempt: state.continuations, max: maxContinuations, command: plan.acceptance.command, result, elapsedMs,
      driver: isDriver(input.model, settings),
    }),
  };
}
