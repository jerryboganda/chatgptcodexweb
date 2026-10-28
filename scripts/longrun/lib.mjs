// Pure policy for the long-run supervisor: failure classification, back-off, prompts and the decision
// of what to do after each Codex round. No I/O here, so every rule is unit-testable.

export const KIND = Object.freeze({
  TRANSIENT: "transient",
  RATE_LIMIT: "rate_limit",
  AUTH: "auth",
  CONTEXT: "context",
  STUCK: "stuck",
  FATAL: "fatal",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULTS = Object.freeze({
  maxHours: 24,
  stallMinutes: 30,
  verifyTimeoutMinutes: 30,
  maxConsecutiveFailures: 8,
  sameThreadFailuresBeforeFresh: 3,
  noProgressRoundsBeforeFresh: 3,
  noProgressRoundsBeforeStop: 6,
  maxContextFreshInARow: 4,
  roundProgressMinutes: 40,
  watchMinutes: 10,
  compactionErrorsBeforeFresh: 3,
  maxStuckInARow: 3,
  maxCompactScale: 4,
  maxAuthWaits: 6,
  authWaitMs: 10 * MINUTE,
  rateLimitDefaultWaitMs: 15 * MINUTE,
  maxWaitMs: 6 * HOUR,
  backoffBaseMs: 15_000,
  backoffMaxMs: 10 * MINUTE,
  maxRounds: 10_000,
});

/** Classify the text of a failed Codex round. Order matters: the first matching rule wins. */
export function classifyFailure(text) {
  const t = String(text ?? "").toLowerCase();
  if (/sign[- ]?in|signed out|log ?in required|authenticat|unauthori[sz]ed|session (has )?expired|\b401\b/.test(t)) return KIND.AUTH;
  if (/usage limit|rate[- ]?limit|too many requests|\b429\b|quota|try again (in|after)|limit (has been )?reached|you'?ve reached|message cap|at capacity/.test(t)) return KIND.RATE_LIMIT;
  if (/ran out of room|context window|context[_ ]length|exceeds the .*limit|compaction (failed|error)|too long/.test(t)) return KIND.CONTEXT;
  if (/unknown model|model[_ ]not[_ ]found|unsupported model|no such model|invalid configuration/.test(t)) return KIND.FATAL;
  // Everything else a browser-backed bridge throws at us (stream drops, tab closed, 5xx, refused connection)
  // is worth another attempt, so unknown text is treated as transient and bounded by the failure counters.
  return KIND.TRANSIENT;
}

const UNIT_MS = [
  [/^(h|hr|hrs|hour|hours)$/, HOUR],
  [/^(m|min|mins|minute|minutes)$/, MINUTE],
  [/^(s|sec|secs|second|seconds)$/, 1000],
];

/** "try again in 2 hours 5 minutes" -> milliseconds, or undefined when the text gives no duration. */
export function parseRetryAfterMs(text) {
  const t = String(text ?? "").toLowerCase();
  const trigger = t.match(/(try again|retry|resets?|available again|come back)( after| in| at)?\s*/);
  if (!trigger) return undefined;
  // Only the quantities written right after the trigger count ("2 hours 5 minutes", "1h, 20m"), so a
  // message repeated further down is not added up twice.
  const rest = t.slice(trigger.index + trigger[0].length);
  let total = 0;
  let at = 0;
  for (;;) {
    const m = rest.slice(at).match(/^(\d+(?:\.\d+)?)\s*([a-z]+)(?:\s*(?:,|and)?\s*)?/);
    const unit = m && UNIT_MS.find(([re]) => re.test(m[2]));
    if (!unit) break;
    total += Number(m[1]) * unit[1];
    at += m[0].length;
  }
  return total > 0 ? Math.min(Math.round(total), DEFAULTS.maxWaitMs) : undefined;
}

/** Exponential back-off with bounded jitter (`jitter` in [0,1) is injected so tests are deterministic). */
export function backoffMs(attempt, jitter = 0, opts = DEFAULTS) {
  const raw = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.75 + 0.5 * jitter));
}

export function capText(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return `${s.slice(0, head)}\n[... ${s.length - max} characters omitted ...]\n${s.slice(s.length - tail)}`;
}

/** Completion is only honoured when the model has written `STATUS: DONE` in its progress file. */
export function parseProgress(text) {
  const s = String(text ?? "");
  const m = s.match(/^\s*STATUS\s*:\s*([A-Za-z_ -]+?)\s*$/im);
  const status = m ? m[1].toUpperCase() : "";
  return { status, done: status === "DONE" };
}

export const PROGRESS_TEMPLATE = `# LONGRUN PROGRESS

STATUS: IN_PROGRESS

## GOAL
(one paragraph: what finished looks like)

## STANDING INSTRUCTIONS
(every rule, convention, name, path and constraint the user gave, verbatim, one per line)

## PLAN
- [ ] (steps, in order)

## DONE
(what is finished and verified, newest last)

## DECISIONS
(choices made and why)

## NEXT
(the single next action)

## HOW TO VERIFY
(exact commands)
`;

export function protocolText(files) {
  return [
    "LONG-RUN PROTOCOL (an unattended supervisor is driving this task and may restart you in a fresh chat at any time):",
    `- Keep ${files.progress} up to date. Update it after every completed step and before any long-running command. Keep these sections: STATUS, GOAL, STANDING INSTRUCTIONS (verbatim), PLAN (checkboxes), DONE, DECISIONS, NEXT, HOW TO VERIFY. Keep it under about 150 lines.`,
    "- A fresh chat will know only what is in that file, the repository and the git history. Anything not written there will be lost.",
    "- Work in small verified steps. Run the project's tests or checks after each step and fix failures before moving on.",
    "- Never delete or rewrite earlier progress; add to it.",
    "- Set the line `STATUS: DONE` only when every requirement is met and the verification commands pass. Otherwise leave `STATUS: IN_PROGRESS`.",
    "- Do not ask the user questions; choose the most reasonable option, record the decision, and continue.",
  ].join("\n");
}

export function buildInitialPrompt({ task, files, verifyCommand }) {
  return [
    task.trim(),
    "",
    protocolText(files),
    verifyCommand ? `\nThe task is accepted only when this command exits with status 0: ${verifyCommand}` : "",
  ].join("\n").trim();
}

export function buildContinuePrompt({ round, files, verifyCommand, verify, reason, hint }) {
  return [
    `Continue the task (supervisor round ${round}${reason ? `, reason: ${reason}` : ""}).`,
    hint ? `Supervisor note: ${hint}` : "",
    `Re-read ${files.progress}, pick up at its NEXT step and do not redo finished work.`,
    verify && !verify.ok
      ? `The acceptance command \`${verifyCommand}\` last failed. Its output ended with:\n${capText(verify.tail, 4000)}\nWhile it fails, ${files.progress} must say \`STATUS: IN_PROGRESS\`.`
      : verify?.ok
        ? `The acceptance command \`${verifyCommand}\` currently passes. If every requirement is truly met, set \`STATUS: DONE\` in ${files.progress}; otherwise keep working through the plan.`
        : "",
    "Keep updating the progress file as you go.",
  ].filter(Boolean).join("\n");
}

/** The progress file lost most of its content since an earlier snapshot (a model "tidied" it too hard, or overwrote it). */
export function progressShrank(current, earlier) {
  const before = String(earlier ?? "").length;
  return before > 1500 && String(current ?? "").trim().length < before * 0.4;
}

const STUCK_NOTE = "The previous chat ran for a long time without changing anything (it kept re-reading files or failing to compact its context). In this chat: do not dump whole files or whole directories into the conversation, read only what the next step needs, write the plan into the progress file first, and make a small change and commit it early.";

/**
 * Prompt for a brand-new chat that must continue the job. `budgetChars` (the context size the chat will have,
 * roughly) shrinks the quoted task, progress file and briefing so the handoff itself cannot overflow a small window.
 */
export function buildHandoffPrompt({ task, files, verifyCommand, progressText, earlierProgress, gitLog, gitStatus, verify, round, reason, brief, hint, budgetChars }) {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? budgetChars : Infinity;
  const share = (fraction, hardCap, floor) => Math.min(hardCap, Math.max(floor, Math.round(budget * fraction)));
  return [
    "You are taking over a long-running task from a previous chat that was interrupted. The previous chat's context is NOT available to you; this message, the repository and the progress file are your complete memory.",
    "",
    "=== ORIGINAL TASK ===",
    capText(task.trim(), share(0.35, 30_000, 4000)),
    "",
    ...(brief ? ["=== BRIEFING FROM THE SUPERVISOR ===", capText(brief, share(0.15, 8000, 2000)), ""] : []),
    ...(hint ? [`Supervisor note: ${hint}`, ""] : []),
    ...(reason === "round_stuck" ? [`Supervisor note: ${STUCK_NOTE}`, ""] : []),
    `=== PROGRESS FILE (${files.progress}) ===`,
    progressText ? capText(progressText, share(0.35, 40_000, 6000)) : "(missing: inspect the repository and git history, then recreate it)",
    "",
    ...(earlierProgress && progressShrank(progressText, earlierProgress)
      ? ["=== EARLIER, LONGER VERSION OF THE PROGRESS FILE (the current one lost content; merge anything still true back into it) ===", capText(earlierProgress, share(0.15, 12_000, 3000)), ""]
      : []),
    "=== RECENT COMMITS ===",
    gitLog || "(none)",
    "",
    "=== UNCOMMITTED CHANGES ===",
    gitStatus || "(clean)",
    verify
      ? `\n=== LAST ACCEPTANCE RESULT (\`${verifyCommand}\`: ${verify.ok ? "passing" : "failing"}) ===\n${capText(verify.tail, 4000)}`
      : "",
    "",
    `Supervisor round ${round}${reason ? ` (handoff reason: ${reason})` : ""}. Verify the repository state against the progress file before trusting either, then continue from the NEXT step. Do not redo finished work.`,
    "",
    protocolText(files),
  ].join("\n");
}

/**
 * What to do after a round. `state` carries counters; the result is { action, waitMs, reason, state }
 * where action is finish | continue | fresh | stop. A wait is performed before continuing/fresh.
 */
export function decideNext({ state, round, verify, progress, fingerprint, now, jitter = 0, opts = DEFAULTS }) {
  const next = { ...state, rounds: state.rounds + 1, lastKind: undefined };
  const stop = (reason) => ({ action: "stop", reason, waitMs: 0, state: { ...next, status: "stopped", stopReason: reason } });

  if (now - state.startedAt > opts.maxHours * HOUR) return stop("time_limit");
  if (next.rounds >= opts.maxRounds) return stop("max_rounds");

  if (round.outcome === "completed") {
    next.consecutiveFailures = 0;
    next.sameThreadFailures = 0;
    next.contextFreshInARow = 0;
    next.stuckInARow = 0;
    next.authWaits = 0;
    const accepted = verify ? verify.ok : true;
    if (accepted && (progress.done || opts.acceptVerifyOnly)) {
      return { action: "finish", reason: "done", waitMs: 0, state: { ...next, status: "done", stopReason: "done" } };
    }
    if (fingerprint !== state.lastFingerprint) next.noProgressRounds = 0;
    else next.noProgressRounds = state.noProgressRounds + 1;
    next.lastFingerprint = fingerprint;
    if (next.noProgressRounds >= opts.noProgressRoundsBeforeStop) return stop("no_progress");
    if (next.noProgressRounds >= opts.noProgressRoundsBeforeFresh && next.noProgressRounds % opts.noProgressRoundsBeforeFresh === 0) {
      return { action: "fresh", reason: "no_progress", waitMs: 0, state: next };
    }
    return { action: "continue", reason: verify && !verify.ok ? "verify_failing" : "not_done", waitMs: 0, state: next };
  }

  // A round that kept running without changing anything (a compaction or re-reading loop) has a poisoned
  // context: resuming it would only repeat the loop, so the next round always starts a fresh chat.
  if (round.outcome === "stuck") {
    next.lastKind = KIND.STUCK;
    next.failuresByKind = { ...state.failuresByKind, [KIND.STUCK]: (state.failuresByKind[KIND.STUCK] ?? 0) + 1 };
    next.stuckInARow = (state.stuckInARow ?? 0) + 1;
    // The usual cause is a context window that is too small for the job (compact, forget, re-read, repeat), so
    // the next chats get a larger forced compaction limit when one was set with --compact-limit.
    next.compactScale = Math.min(opts.maxCompactScale, (state.compactScale ?? 1) * 1.5);
    next.consecutiveFailures = state.consecutiveFailures + 1;
    next.sameThreadFailures = 0;
    if (next.consecutiveFailures > opts.maxConsecutiveFailures) return stop("too_many_failures");
    if (next.stuckInARow > opts.maxStuckInARow) return stop("stuck_loop");
    return { action: "fresh", reason: "round_stuck", waitMs: backoffMs(next.consecutiveFailures, jitter, opts), state: next };
  }

  // failed | stalled | crashed
  const kind = round.outcome === "stalled" ? KIND.TRANSIENT : round.kind ?? classifyFailure(round.failureText);
  next.lastKind = kind;
  next.failuresByKind = { ...state.failuresByKind, [kind]: (state.failuresByKind[kind] ?? 0) + 1 };

  if (kind === KIND.FATAL) return stop("fatal_error");
  if (kind === KIND.AUTH) {
    next.authWaits = state.authWaits + 1;
    if (next.authWaits > opts.maxAuthWaits) return stop("needs_login");
    return { action: "continue", reason: "waiting_for_login", waitMs: opts.authWaitMs, state: next };
  }
  if (kind === KIND.RATE_LIMIT) {
    const waitMs = Math.min(opts.maxWaitMs, parseRetryAfterMs(round.failureText) ?? opts.rateLimitDefaultWaitMs);
    return { action: "continue", reason: "rate_limited", waitMs, state: next };
  }

  next.consecutiveFailures = state.consecutiveFailures + 1;
  next.sameThreadFailures = state.sameThreadFailures + 1;
  if (next.consecutiveFailures > opts.maxConsecutiveFailures) return stop("too_many_failures");
  const waitMs = backoffMs(next.consecutiveFailures, jitter, opts);

  if (kind === KIND.CONTEXT) {
    next.contextFreshInARow = state.contextFreshInARow + 1;
    if (next.contextFreshInARow > opts.maxContextFreshInARow) return stop("context_exhausted");
    next.sameThreadFailures = 0;
    return { action: "fresh", reason: "context_exhausted_in_chat", waitMs, state: next };
  }
  if (next.sameThreadFailures >= opts.sameThreadFailuresBeforeFresh) {
    next.sameThreadFailures = 0;
    return { action: "fresh", reason: "chat_keeps_failing", waitMs, state: next };
  }
  return { action: "continue", reason: `retry_after_${kind}`, waitMs, state: next };
}

export function initialState({ id, taskHash, now, branch }) {
  return {
    id,
    taskHash,
    branch,
    status: "running",
    startedAt: now,
    rounds: 0,
    threadId: undefined,
    threads: [],
    consecutiveFailures: 0,
    sameThreadFailures: 0,
    contextFreshInARow: 0,
    stuckInARow: 0,
    compactScale: 1,
    authWaits: 0,
    noProgressRounds: 0,
    lastFingerprint: "",
    failuresByKind: {},
    controllerCalls: 0,
    controllerFailures: 0,
    pending: "initial",
  };
}

// ---------------------------------------------------------------------------------------------
// Controller: a small model (Luna by default) that advises the supervisor. Its answer is only ever a
// suggestion; `mergeControllerAdvice` keeps the deterministic policy in charge of the hard limits.
// ---------------------------------------------------------------------------------------------

export const CONTROLLER_DEFAULTS = Object.freeze({ model: "gpt-6-luna", effort: "high", timeoutMinutes: 6 });
export const CONTROLLER_MARK = Object.freeze({ decide: "[longrun-controller:decide]", brief: "[longrun-controller:brief]", watch: "[longrun-controller:watch]" });

/** First balanced JSON object inside free text (models sometimes wrap it in prose or a code fence). */
export function extractJson(text) {
  const s = String(text ?? "");
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inString) {
        if (c === "\\") i += 1;
        else if (c === "\"") inString = false;
      } else if (c === "\"") inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return undefined;
}

const ADVICE_ACTIONS = new Set(["continue", "fresh", "stop"]);
const HEALTH = new Set(["ok", "degraded", "polluted"]);

/** Accepts only a well-formed advice object; anything else is ignored rather than trusted. */
export function normalizeAdvice(raw) {
  if (!raw || typeof raw !== "object" || !ADVICE_ACTIONS.has(raw.action)) return undefined;
  const wait = Number(raw.waitSeconds);
  return {
    action: raw.action,
    waitSeconds: Number.isFinite(wait) && wait >= 0 ? wait : undefined,
    contextHealth: HEALTH.has(raw.contextHealth) ? raw.contextHealth : "ok",
    reason: String(raw.reason ?? "").slice(0, 300),
    nextHint: String(raw.nextHint ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
}

export function buildDecidePrompt(e) {
  return [
    CONTROLLER_MARK.decide,
    "You supervise an unattended long-running coding agent that works in a chat. Do not run any tools or commands; just read the evidence below and answer.",
    "Decide how the NEXT round should run:",
    "- \"continue\": keep working in the same chat (it keeps its full memory). This is the default when the chat is healthy, even if a round failed for a transient reason.",
    "- \"fresh\": open a new chat that receives a written briefing. Choose this when the chat looks confused, repeats itself, mixes up unrelated work or earlier tasks, contradicts the progress file or the repository, keeps failing the same way, or has lost details it should know.",
    "- \"stop\": only when continuing is clearly pointless or unsafe (state the reason).",
    "Also rate contextHealth: \"ok\", \"degraded\" (small drift), or \"polluted\" (the chat is mixing contexts or has lost the thread). waitSeconds is an optional pause before the next round (0 to 900).",
    "nextHint is optional guidance for the agent's next round (at most 400 characters): name the concrete problem and the next step, for example the failing check and the file to open.",
    "The supervisor already proposes an action; you may agree or override it.",
    "Reply with ONE JSON object only, no prose: {\"action\":\"continue|fresh|stop\",\"waitSeconds\":0,\"contextHealth\":\"ok|degraded|polluted\",\"reason\":\"one sentence\",\"nextHint\":\"\"}",
    "",
    "=== EVIDENCE ===",
    e,
  ].join("\n");
}

const WATCH_ACTIONS = new Set(["wait", "fresh", "restart"]);

/** Accepts only a well-formed mid-round verdict; anything else means "keep waiting". */
export function normalizeWatchAdvice(raw) {
  if (!raw || typeof raw !== "object" || !WATCH_ACTIONS.has(raw.action)) return undefined;
  return { action: raw.action, reason: String(raw.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) };
}

/** The controller's check on a round that is still running but has changed nothing for a while. */
export function buildWatchPrompt(e) {
  return [
    CONTROLLER_MARK.watch,
    "You supervise an unattended long-running coding agent. Its current round is still running, but nothing in the repository or its progress file has changed for a while. Do not run any tools or commands; read the evidence and judge what is going on.",
    "Choose one:",
    "- \"wait\": the agent is plausibly working (long reasoning, a long build or test run, a large file being written, normal variety in its commands). This is the right answer unless there are clear signs of trouble.",
    "- \"fresh\": the chat is stuck in a loop or poisoned: the same commands or file dumps repeat, compaction or reconnect errors keep coming, it re-reads the project over and over without writing anything, or it is confused about the task. The round is killed and the work continues in a NEW chat that gets a briefing.",
    "- \"restart\": the process is hung or disconnected: it has produced NO output at all for many minutes (see \"Time since the process last produced any output\"; reconnect notices do not count) but the chat itself is fine. The round is killed and the SAME chat is resumed. Never choose this while output is still arriving.",
    "No change to the repository is NOT by itself a sign of trouble: the agent may be reading, reasoning for a long time or running tests. Waiting costs time; a needless fresh chat costs context. Prefer \"wait\" for ordinary slowness, and decide firmly when the evidence shows a loop or a silent process.",
    "Reply with ONE JSON object only, no prose: {\"action\":\"wait|fresh|restart\",\"reason\":\"one sentence naming the evidence\"}",
    "",
    "=== EVIDENCE ===",
    e,
  ].join("\n");
}

export function buildBriefPrompt(e) {
  return [
    CONTROLLER_MARK.brief,
    "A long-running coding agent's chat is being replaced by a new chat. Write the briefing the new chat needs so that it continues exactly where the old one stopped. Do not run any tools or commands.",
    "Use only the evidence below. Cover, in this order and tersely: (1) the goal and the standing rules/conventions, word for word; (2) what is finished and verified; (3) what was in progress when the chat ended and its exact state; (4) the most likely next step; (5) pitfalls: what failed, why, and anything the old chat may have got wrong or confused. Do not invent facts. At most 5000 characters. Plain text, no preamble.",
    "",
    "=== EVIDENCE ===",
    e,
  ].join("\n");
}

/**
 * Combine the policy's decision with the controller's advice. The controller can switch between
 * continuing and a fresh chat, add a hint, lengthen or shorten a back-off, and (after repeated
 * failures) recommend stopping. It can never override rate-limit or login waits, a full context
 * window, or any stop, and it can never declare the task finished.
 */
export function mergeControllerAdvice({ decision, advice, state, opts = DEFAULTS }) {
  if (!advice || decision.action === "stop" || decision.action === "finish") return decision;
  if (decision.reason === "rate_limited" || decision.reason === "waiting_for_login") return decision;
  const merged = { ...decision, state: { ...decision.state }, advisedBy: "controller", advice };
  if (advice.nextHint) merged.state.hint = advice.nextHint;

  let action = decision.action;
  if (advice.action === "continue") action = "continue";
  if (advice.action === "fresh" || advice.contextHealth === "polluted") action = "fresh";
  if (decision.reason === "context_exhausted_in_chat" || decision.reason === "round_stuck") action = "fresh";
  if (advice.action === "stop" && state.consecutiveFailures >= 3) {
    return { ...merged, action: "stop", reason: "controller_stop", waitMs: 0, state: { ...merged.state, status: "stopped", stopReason: "controller_stop" } };
  }
  if (action !== decision.action) {
    merged.action = action;
    merged.reason = `controller_${action}`;
    merged.state.sameThreadFailures = 0;
    if (action === "fresh") merged.state.noProgressRounds = 0;
  }
  if (advice.waitSeconds !== undefined && decision.waitMs > 0) {
    const asked = Math.min(opts.maxWaitMs, advice.waitSeconds * 1000);
    merged.waitMs = Math.max(Math.round(decision.waitMs / 2), asked);
  }
  return merged;
}
