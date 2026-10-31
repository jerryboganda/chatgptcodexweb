import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { workTreeFingerprint } from "./fingerprint";
import { resolveProject, type ProjectPlan } from "./project";
import { loadLongrunSettings, longrunDirectory, type LongrunSettings } from "./settings";
import { shipState, type ShipState } from "./ship";
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
    "Follow the section \"Luna drives, Sol works\" of your instructions (~/.codex/AGENTS.md): create .longrun/PROGRESS.md, write each slice to .longrun/brief.md,",
    "run the worker command given there, then read the result and the diff.",
    "Nobody runs tests, builds, package scripts (npm, bun, pnpm, yarn, pip, cargo, go) or any acceptance check: not you, not the worker, not the VPS.",
    "When the work is done you commit everything, push to main, look at the GitHub Actions run once and report it; the project's workflow deploys.",
    "This applies even when the task looks small or is only a question about the project.",
  ].join(" ");
}

export interface HookDeps {
  home: string;
  now: () => number;
  settings: () => LongrunSettings;
  project: (cwd: string) => ProjectPlan;
  fingerprint: (cwd: string) => string;
  /** What is left to commit or push in the folder; undefined when it is not a git work tree. */
  ship: (cwd: string) => ShipState | undefined;
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
    ship: shipState,
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

function shipReason(options: { attempt: number; max: number; state: ShipState; elapsedMs: number }): string {
  const { state } = options;
  const left = [
    state.dirty ? "changes that are not committed" : "",
    state.ahead > 0 ? `${state.ahead} commit${state.ahead === 1 ? "" : "s"} that ${state.ahead === 1 ? "is" : "are"} not pushed` : "",
  ].filter(Boolean).join(" and ");
  return [
    `${LONGRUN_MARK} The work is not shipped yet: there are ${left} (reminder ${options.attempt} of ${options.max}, ${minutes(options.elapsedMs)} min in).`,
    "Finish the flow: read the diff, commit everything, push to main, then look at the GitHub Actions run once (`gh run list --branch main --limit 3`, or `gh run watch` with a long poll) and say what it shows. The project's workflow deploys.",
    "Do not run tests, builds or package scripts here or on the server. If the CI run fails, report the run link and the failing job in your answer; the user checks it online and reports back.",
    "If you cannot ship (no git remote, no GitHub login, a decision that is the user's), say exactly why under \"manual steps\" in PROGRESS.md and in your answer instead of stopping silently.",
  ].join("\n");
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
  // A worker job is shipped by the driver that started it: remember the session so its Stop hook stays out of the way.
  if (isWorkerPrompt(text(input.prompt))) {
    saveState({ ...freshState(sessionId, "worker", deps.now()), worker: true }, deps.home);
    deps.log("worker_session", { session: sessionId });
    return undefined;
  }
  const previous = loadState(sessionId, deps.home);
  const state = freshState(sessionId, deps.fingerprint(cwd), deps.now());
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

/**
 * Stop: a driver that ends its turn with work that is not committed and pushed is sent back to ship it. There is no
 * test or acceptance check: nothing in a project is run here, only `git status` is read.
 */
export async function handleStop(input: StopHookInput, deps: HookDeps): Promise<HookOutput> {
  const settings = deps.settings();
  if (!settings.enabled || input.agent_id || !validSessionId(input.session_id) || !isDriver(input.model, settings)) return undefined;
  const cwd = text(input.cwd);
  if (!cwd) return undefined;
  const sessionId = input.session_id;
  const plan = deps.project(cwd);
  if (!plan.enabled) return undefined;

  let state = loadState(sessionId, deps.home);
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

  if (endsWithQuestion(text(input.last_assistant_message))) {
    deps.log("waiting_for_user", { session: sessionId });
    return undefined;
  }

  const maxContinuations = Math.min(settings.maxContinuations, plan.maxContinuations ?? settings.maxContinuations);
  const elapsedMs = deps.now() - state.taskStartedAt;
  if (elapsedMs > settings.maxHours * 3_600_000) {
    saveState({ ...state, gaveUp: true, baseline: before }, deps.home);
    deps.log("gave_up", { session: sessionId, why: "hours", continuations: state.continuations });
    return { systemMessage: `${LONGRUN_MARK} Stopped reminding on my own: the ${settings.maxHours} hour budget for this request is used up.` };
  }

  // A worker left running (for instance after the turn that started it was interrupted) is still writing in this
  // folder, so the work is not finished: wait for it, and send the driver back to it only if it outlasts the wait.
  const running = await deps.waitForWorker?.(cwd, WORKER_WAIT_MS);
  if (running) {
    deps.log("worker_busy", { session: sessionId });
    return {
      decision: "block",
      reason: `${LONGRUN_MARK} A worker is still running in this folder (${describeWorker(running, deps.now())}). Wait for the worker command to finish and read its report in .longrun/worker-report.md, or stop it with the worker command's \`stop\` action if you no longer need it. Then finish the work and ship it.`,
    };
  }

  const left = deps.ship(cwd);
  if (!left || (!left.dirty && left.ahead === 0)) {
    saveState({ ...state, continuations: 0, baseline: deps.fingerprint(cwd), gaveUp: false }, deps.home);
    deps.log("shipped", { session: sessionId, reminders: state.continuations });
    return undefined;
  }
  if (state.continuations >= maxContinuations) {
    saveState({ ...state, gaveUp: true, baseline: before }, deps.home);
    deps.log("gave_up", { session: sessionId, why: "reminders", continuations: state.continuations });
    return { systemMessage: `${LONGRUN_MARK} The work is still not committed and pushed after ${maxContinuations} reminders. Send a message to start another attempt.` };
  }
  state = { ...state, continuations: state.continuations + 1, baseline: before };
  saveState(state, deps.home);
  deps.log("remind_ship", { session: sessionId, reminder: state.continuations, dirty: left.dirty, ahead: left.ahead });
  return { decision: "block", reason: shipReason({ attempt: state.continuations, max: maxContinuations, state: left, elapsedMs }) };
}
