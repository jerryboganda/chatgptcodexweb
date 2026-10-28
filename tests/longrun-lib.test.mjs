import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULTS, KIND, backoffMs, buildHandoffPrompt, buildInitialPrompt, capText, classifyFailure, decideNext, extractJson, initialState,
  mergeControllerAdvice, normalizeAdvice, parseProgress, parseRetryAfterMs,
} from "../scripts/longrun/lib.mjs";

const files = { progress: ".longrun/PROGRESS.md" };
const fresh = () => initialState({ id: "t", taskHash: "h", now: 1_000 });
const decide = (over) => decideNext({
  state: fresh(), round: { outcome: "completed" }, verify: undefined, progress: { done: false }, fingerprint: "a", now: 2_000, ...over,
});

test("failure text is classified so each kind gets its own treatment", () => {
  assert.equal(classifyFailure("stream disconnected before completion: ChatGPT stopped responding"), KIND.TRANSIENT);
  assert.equal(classifyFailure("connect ECONNREFUSED 127.0.0.1:17841"), KIND.TRANSIENT);
  assert.equal(classifyFailure("You've reached the usage limit. Try again in 3 hours"), KIND.RATE_LIMIT);
  assert.equal(classifyFailure("ChatGPT requested sign-in"), KIND.AUTH);
  assert.equal(classifyFailure("Codex ran out of room in the model's context window"), KIND.CONTEXT);
  assert.equal(classifyFailure("unknown model chatgpt-web/nope"), KIND.FATAL);
  assert.equal(classifyFailure(""), KIND.TRANSIENT);
});

test("retry-after durations are read from the message and bounded", () => {
  assert.equal(parseRetryAfterMs("Try again in 2 hours 5 minutes"), 2 * 3_600_000 + 5 * 60_000);
  assert.equal(parseRetryAfterMs("please retry after 45 seconds"), 45_000);
  assert.equal(parseRetryAfterMs("usage limit reached"), undefined);
  assert.equal(parseRetryAfterMs("try again in 400 hours"), DEFAULTS.maxWaitMs);
});

test("back-off grows, is capped and stays inside the jitter band", () => {
  assert.equal(backoffMs(1, 0.5), 15_000);
  assert.ok(backoffMs(2, 0.5) > backoffMs(1, 0.5));
  assert.equal(backoffMs(30, 0.5), DEFAULTS.backoffMaxMs);
  assert.ok(backoffMs(3, 0) >= 0.75 * 60_000 - 1 && backoffMs(3, 0.999) <= 1.25 * 60_000);
});

test("only STATUS: DONE counts as finished", () => {
  assert.equal(parseProgress("# P\n\nSTATUS: DONE\n").done, true);
  assert.equal(parseProgress("status: done").done, true);
  assert.equal(parseProgress("STATUS: IN_PROGRESS").done, false);
  assert.equal(parseProgress("all DONE soon").done, false);
});

test("a finished round needs both a passing acceptance command and the DONE flag", () => {
  assert.equal(decide({ verify: { ok: true }, progress: { done: true } }).action, "finish");
  assert.equal(decide({ verify: { ok: true }, progress: { done: false } }).action, "continue");
  assert.equal(decide({ verify: { ok: false }, progress: { done: true } }).action, "continue");
  assert.equal(decide({ verify: { ok: true }, progress: { done: false }, opts: { ...DEFAULTS, acceptVerifyOnly: true } }).action, "finish");
});

test("rounds that change nothing lead to a fresh chat and then a stop", () => {
  let state = fresh();
  const actions = [];
  for (let i = 0; i < 7; i += 1) {
    const d = decide({ state, fingerprint: "same", now: 2_000 + i });
    actions.push(d.action);
    state = d.state;
    if (d.action === "stop") break;
  }
  assert.deepEqual(actions, ["continue", "continue", "continue", "fresh", "continue", "continue", "stop"]);
  assert.equal(state.stopReason, "no_progress");
  const first = decide({ fingerprint: "a" });
  assert.equal(first.state.noProgressRounds, 0);
});

test("transient failures back off, move to a fresh chat, then give up", () => {
  let state = fresh();
  const seen = [];
  for (let i = 0; i < 10; i += 1) {
    const d = decide({ state, round: { outcome: "failed", failureText: "stream disconnected" } });
    seen.push(d.action);
    state = d.state;
    if (d.action === "stop") break;
    assert.ok(d.waitMs > 0);
  }
  assert.deepEqual(seen.slice(0, 4), ["continue", "continue", "fresh", "continue"]);
  assert.equal(seen.at(-1), "stop");
  assert.equal(state.stopReason, "too_many_failures");
});

test("a stalled round is treated like a transient failure", () => {
  const d = decide({ round: { outcome: "stalled", failureText: "no output" } });
  assert.equal(d.action, "continue");
  assert.equal(d.state.failuresByKind.transient, 1);
});

test("rate limits wait for the stated time and do not count as failures", () => {
  const d = decide({ round: { outcome: "failed", failureText: "usage limit reached, try again in 2 hours" } });
  assert.equal(d.action, "continue");
  assert.equal(d.waitMs, 2 * 3_600_000);
  assert.equal(d.state.consecutiveFailures, 0);
});

test("a full context window moves the work to a fresh chat", () => {
  const d = decide({ round: { outcome: "failed", failureText: "Codex ran out of room in the model's context window" } });
  assert.equal(d.action, "fresh");
});

test("login problems wait, then stop with a clear reason; fatal errors stop at once", () => {
  let state = fresh();
  let last;
  for (let i = 0; i < DEFAULTS.maxAuthWaits + 1; i += 1) {
    last = decide({ state, round: { outcome: "failed", failureText: "ChatGPT requested sign-in" } });
    state = last.state;
  }
  assert.equal(last.action, "stop");
  assert.equal(last.state.stopReason, "needs_login");
  assert.equal(decide({ round: { outcome: "failed", failureText: "unknown model x" } }).state.stopReason, "fatal_error");
});

test("the wall-clock budget stops the run but keeps its state resumable", () => {
  const d = decide({ now: 1_000 + 25 * 3_600_000 });
  assert.equal(d.action, "stop");
  assert.equal(d.state.stopReason, "time_limit");
});

test("the handoff prompt carries everything a fresh chat needs", () => {
  const prompt = buildHandoffPrompt({
    task: "Build the thing", files, verifyCommand: "npm test", progressText: "STATUS: IN_PROGRESS\n## NEXT\nwrite csv.js",
    gitLog: "abc123 add money", gitStatus: " M src/csv.js", verify: { ok: false, tail: "1 failing" }, round: 7, reason: "chat_keeps_failing",
  });
  for (const part of ["Build the thing", "write csv.js", "abc123 add money", "src/csv.js", "1 failing", "npm test", "round 7", "LONG-RUN PROTOCOL"]) {
    assert.ok(prompt.includes(part), part);
  }
  assert.ok(buildInitialPrompt({ task: "T", files, verifyCommand: "npm test" }).includes("exits with status 0: npm test"));
});

test("long text keeps its head and tail", () => {
  const text = `${"a".repeat(500)}${"b".repeat(500)}`;
  const capped = capText(text, 200);
  assert.ok(capped.startsWith("aaa") && capped.endsWith("bbb") && capped.includes("omitted"));
});

const advised = (over) => normalizeAdvice({ action: "continue", contextHealth: "ok", reason: "r", ...over });
const proposal = (action, reason, over = {}) => ({ action, reason, waitMs: 0, state: { ...fresh(), ...over } });

test("controller answers are parsed from prose and code fences, and malformed ones are dropped", () => {
  assert.deepEqual(extractJson(`Sure:
\`\`\`json
{"action":"fresh","note":"a } brace"}
\`\`\``), { action: "fresh", note: "a } brace" });
  assert.equal(extractJson("no json here"), undefined);
  assert.equal(normalizeAdvice({ action: "dance" }), undefined);
  assert.equal(normalizeAdvice(null), undefined);
  assert.equal(advised({ nextHint: "x".repeat(900) }).nextHint.length, 500);
  assert.equal(advised({ contextHealth: "weird" }).contextHealth, "ok");
});

test("the controller can switch between continuing and a fresh chat, and add a hint", () => {
  const toFresh = mergeControllerAdvice({ decision: proposal("continue", "not_done"), advice: advised({ action: "fresh", nextHint: "look at csv.js" }), state: fresh() });
  assert.equal(toFresh.action, "fresh");
  assert.equal(toFresh.state.hint, "look at csv.js");
  const polluted = mergeControllerAdvice({ decision: proposal("continue", "not_done"), advice: advised({ contextHealth: "polluted" }), state: fresh() });
  assert.equal(polluted.action, "fresh");
  const veto = mergeControllerAdvice({ decision: proposal("fresh", "chat_keeps_failing", { sameThreadFailures: 0 }), advice: advised({ action: "continue" }), state: fresh() });
  assert.equal(veto.action, "continue");
});

test("the controller cannot override hard rules", () => {
  const full = mergeControllerAdvice({ decision: proposal("fresh", "context_exhausted_in_chat"), advice: advised({ action: "continue" }), state: fresh() });
  assert.equal(full.action, "fresh");
  for (const reason of ["rate_limited", "waiting_for_login"]) {
    const d = proposal("continue", reason);
    assert.equal(mergeControllerAdvice({ decision: d, advice: advised({ action: "fresh" }), state: fresh() }), d);
  }
  const stopped = { action: "stop", reason: "fatal_error", waitMs: 0, state: fresh() };
  assert.equal(mergeControllerAdvice({ decision: stopped, advice: advised({ action: "continue" }), state: fresh() }), stopped);
  const finished = { action: "finish", reason: "done", waitMs: 0, state: fresh() };
  assert.equal(mergeControllerAdvice({ decision: finished, advice: advised({ action: "fresh" }), state: fresh() }), finished);
  assert.equal(mergeControllerAdvice({ decision: proposal("continue", "x"), advice: undefined, state: fresh() }).action, "continue");
});

test("a stop recommendation needs repeated failures; waits can only be reshaped within bounds", () => {
  const early = mergeControllerAdvice({ decision: proposal("continue", "retry_after_transient"), advice: advised({ action: "stop" }), state: fresh() });
  assert.equal(early.action, "continue");
  const late = mergeControllerAdvice({ decision: proposal("continue", "retry_after_transient", { consecutiveFailures: 3 }), advice: advised({ action: "stop" }), state: { ...fresh(), consecutiveFailures: 3 } });
  assert.equal(late.action, "stop");
  assert.equal(late.state.stopReason, "controller_stop");
  const longer = mergeControllerAdvice({ decision: { ...proposal("continue", "retry_after_transient"), waitMs: 60_000 }, advice: advised({ waitSeconds: 300 }), state: fresh() });
  assert.equal(longer.waitMs, 300_000);
  const shorter = mergeControllerAdvice({ decision: { ...proposal("continue", "retry_after_transient"), waitMs: 60_000 }, advice: advised({ waitSeconds: 1 }), state: fresh() });
  assert.equal(shorter.waitMs, 30_000);
  const huge = mergeControllerAdvice({ decision: { ...proposal("continue", "retry_after_transient"), waitMs: 60_000 }, advice: advised({ waitSeconds: 10 ** 9 }), state: fresh() });
  assert.equal(huge.waitMs, DEFAULTS.maxWaitMs);
});
