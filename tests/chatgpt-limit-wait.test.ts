import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  CAPACITY_BACKOFF_MS,
  CHATGPT_MODEL_AT_CAPACITY_CODE,
  CHATGPT_USAGE_LIMIT_CODE,
  DEFAULT_LIMIT_WAIT_BUDGET_MS,
  LIMIT_WAIT_MINUTES_ENV,
  RETRY_AFTER_MARGIN_MS,
  USAGE_LIMIT_DEFAULT_WAIT_MS,
  abortableDelay,
  chatGptLimitErrorAfterWaiting,
  chatGptLimitKindOfError,
  chatGptModelAtCapacityError,
  chatGptRetryAfterMsOfError,
  chatGptUsageLimitError,
  classifyChatGptLimitText,
  formatChatGptDuration,
  limitWaitDelayMs,
  parseChatGptRetryAfterMs,
  resolveLimitWaitBudgetMs,
} from "../src/adapters/chatgpt-web/limit-wait";
import {
  ChatGptWebTurnRetryPolicy,
  MAX_CHATGPT_WEB_TURN_RETRIES,
  chatGptLimitGiveUpError,
} from "../src/adapters/chatgpt-web/retry-policy";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("parsing what ChatGPT says about when a limit clears", () => {
  test.each([
    ["Try again in 2 hours 5 minutes.", 2 * HOUR + 5 * MINUTE],
    ["You've reached the usage limit. Please try again in 45 minutes.", 45 * MINUTE],
    ["try again in about 3 hours", 3 * HOUR],
    ["Try again in 1h 20m", HOUR + 20 * MINUTE],
    ["Try again in 1 hour, 20 minutes and 30 seconds", HOUR + 20 * MINUTE + 30_000],
    ["Come back in an hour", HOUR],
    ["Your limit resets in 2 days", 2 * 24 * HOUR],
    ["Try again in less than a minute", MINUTE],
    ["Try again in 30 seconds", 30_000],
  ])("%s", (text, expected) => {
    expect(parseChatGptRetryAfterMs(text)).toBe(expected);
  });

  test.each([
    "Usage limit reached.",
    "Try again later.",
    "Try again in a few minutes.",
    "You can use it again after 3:15 PM.",
    "Try again at 10:30 AM tomorrow",
    "",
    undefined,
  ])("states no duration: %p", text => {
    expect(parseChatGptRetryAfterMs(text)).toBeUndefined();
  });

  test("an absurd wait is clamped instead of overflowing a timer", () => {
    expect(parseChatGptRetryAfterMs("Try again in 99999 days")).toBe(7 * 24 * HOUR);
  });

  test("a formatted duration parses back to at least the same wait", () => {
    for (const ms of [30_000, 90_000, 45 * MINUTE, 2 * HOUR + 5 * MINUTE, 26 * HOUR]) {
      const text = `Try again in ${formatChatGptDuration(ms)}.`;
      const parsed = parseChatGptRetryAfterMs(text)!;
      expect(parsed).toBeGreaterThanOrEqual(ms);
      expect(parsed - ms).toBeLessThan(MINUTE);
    }
  });
});

describe("classifying ChatGPT's own notices", () => {
  test("the model-at-capacity notice from a real run", () => {
    expect(classifyChatGptLimitText("Selected model is at capacity. Please try a different model.")).toEqual({ kind: "capacity" });
    expect(classifyChatGptLimitText("That model is currently overloaded with other requests.")).toEqual({ kind: "capacity" });
    expect(classifyChatGptLimitText("We're experiencing high demand right now. Try again in 5 minutes."))
      .toEqual({ kind: "capacity", retryAfterMs: 5 * MINUTE });
  });

  test("a usage limit carries the stated wait when there is one", () => {
    expect(classifyChatGptLimitText("You've reached your usage limit. Try again in 2 hours 5 minutes."))
      .toEqual({ kind: "usage_limit", retryAfterMs: 2 * HOUR + 5 * MINUTE });
    expect(classifyChatGptLimitText("You've hit the message limit for GPT-5.6 Pro")).toEqual({ kind: "usage_limit" });
    expect(classifyChatGptLimitText("Usage limit reached")).toEqual({ kind: "usage_limit" });
    expect(classifyChatGptLimitText("Usage limit. Try again in 3 hours")).toEqual({ kind: "usage_limit", retryAfterMs: 3 * HOUR });
  });

  test.each([
    // The burst-throttle dialog stays its own deliberate hard stop.
    "Too many requests. You're making requests too quickly.",
    // Other classified limits.
    "ChatGPT has reached its file-upload limit.",
    "The message you submitted was too long, please edit it and resubmit.",
    "This task exceeds the 225,000-token context window.",
    // Warnings and marketing are not failures.
    "You're approaching your usage limit.",
    "You have 3 messages left before you hit the limit.",
    "Upgrade to Plus for higher usage limits.",
    "Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
    "",
  ])("is not a wait: %s", text => {
    expect(classifyChatGptLimitText(text)).toBeUndefined();
  });

  test("an unbounded blob is not classified", () => {
    expect(classifyChatGptLimitText(`Selected model is at capacity ${"x".repeat(3_000)}`)).toBeUndefined();
  });
});

describe("the errors", () => {
  test("capacity and usage limit are distinct, not retryable by Codex, and carry their wait in the message", () => {
    const capacity = chatGptModelAtCapacityError();
    expect(capacity).toMatchObject({ status: 503, errorType: "server_error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: false });
    expect(capacity.message).toContain("at capacity");
    expect(chatGptLimitKindOfError(capacity)).toBe("capacity");
    expect(chatGptRetryAfterMsOfError(capacity)).toBeUndefined();

    const usage = chatGptUsageLimitError(2 * HOUR + 5 * MINUTE);
    expect(usage).toMatchObject({ status: 429, errorType: "rate_limit_error", code: CHATGPT_USAGE_LIMIT_CODE, retryable: false });
    expect(usage.message).toContain("usage limit");
    expect(chatGptLimitKindOfError(usage)).toBe("usage_limit");
    // The wait survives the browser helper's process boundary, which carries only the message.
    expect(chatGptRetryAfterMsOfError(usage)).toBe(2 * HOUR + 5 * MINUTE);
    expect(chatGptUsageLimitError().message).toContain("did not say when");
    expect(chatGptRetryAfterMsOfError(chatGptUsageLimitError())).toBeUndefined();
  });

  test("other failures are not limits", () => {
    expect(chatGptLimitKindOfError(new Error("at capacity"))).toBeUndefined();
    expect(chatGptLimitKindOfError(new ChatGptWebAdapterError("x", {
      status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false,
    }))).toBeUndefined();
  });

  test("a message that already explains the wait keeps its code and stays final", () => {
    const original = chatGptModelAtCapacityError();
    const final = chatGptLimitErrorAfterWaiting(original, "The bridge already waited 2 hours over 9 retries.");
    expect(final).toMatchObject({ code: CHATGPT_MODEL_AT_CAPACITY_CODE, status: 503, retryable: false });
    expect(final.message).toContain("already waited 2 hours");
  });
});

describe("how long to wait", () => {
  test("capacity backs off and then repeats its longest delay", () => {
    expect([0, 1, 2, 3, 4, 20].map(prior => limitWaitDelayMs("capacity", prior))).toEqual(
      [...CAPACITY_BACKOFF_MS, CAPACITY_BACKOFF_MS.at(-1)!, CAPACITY_BACKOFF_MS.at(-1)!],
    );
  });

  test("a usage limit waits the stated time plus a margin, or a long default when none is stated", () => {
    expect(limitWaitDelayMs("usage_limit", 0, 2 * HOUR)).toBe(2 * HOUR + RETRY_AFTER_MARGIN_MS);
    expect(limitWaitDelayMs("usage_limit", 5)).toBe(USAGE_LIMIT_DEFAULT_WAIT_MS);
    expect(limitWaitDelayMs("capacity", 3, 10 * MINUTE)).toBe(10 * MINUTE + RETRY_AFTER_MARGIN_MS);
  });

  describe("the budget", () => {
    const saved = process.env[LIMIT_WAIT_MINUTES_ENV];
    beforeEach(() => { delete process.env[LIMIT_WAIT_MINUTES_ENV]; });
    afterEach(() => {
      if (saved === undefined) delete process.env[LIMIT_WAIT_MINUTES_ENV];
      else process.env[LIMIT_WAIT_MINUTES_ENV] = saved;
    });

    test("defaults to two hours, can be configured, and 0 disables waiting", () => {
      expect(DEFAULT_LIMIT_WAIT_BUDGET_MS).toBe(2 * HOUR);
      expect(resolveLimitWaitBudgetMs(undefined)).toBe(2 * HOUR);
      expect(resolveLimitWaitBudgetMs(45 * MINUTE)).toBe(45 * MINUTE);
      expect(resolveLimitWaitBudgetMs(0)).toBe(0);
      expect(resolveLimitWaitBudgetMs(-1)).toBe(2 * HOUR);
      expect(resolveLimitWaitBudgetMs(Number.NaN)).toBe(2 * HOUR);
      expect(resolveLimitWaitBudgetMs("soon")).toBe(2 * HOUR);
      expect(resolveLimitWaitBudgetMs(10_000 * HOUR)).toBe(24 * HOUR);
    });

    test("the environment overrides the provider setting; garbage is ignored", () => {
      expect(resolveLimitWaitBudgetMs(45 * MINUTE, { [LIMIT_WAIT_MINUTES_ENV]: "30" })).toBe(30 * MINUTE);
      expect(resolveLimitWaitBudgetMs(45 * MINUTE, { [LIMIT_WAIT_MINUTES_ENV]: "0" })).toBe(0);
      expect(resolveLimitWaitBudgetMs(45 * MINUTE, { [LIMIT_WAIT_MINUTES_ENV]: "abc" })).toBe(45 * MINUTE);
      expect(resolveLimitWaitBudgetMs(undefined, { [LIMIT_WAIT_MINUTES_ENV]: "-5" })).toBe(2 * HOUR);
    });
  });
});

describe("abortableDelay", () => {
  const abortError = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("aborted"));

  test("resolves after the delay and immediately for none", async () => {
    const started = performance.now();
    await abortableDelay(30, undefined, abortError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    await abortableDelay(0, undefined, abortError);
  });

  test("rejects the moment the signal aborts, before or during the wait", async () => {
    const controller = new AbortController();
    const waiting = abortableDelay(60_000, controller.signal, abortError);
    controller.abort(new Error("client went away"));
    await expect(waiting).rejects.toThrow("client went away");
    await expect(abortableDelay(60_000, controller.signal, abortError)).rejects.toThrow("client went away");
  });
});

describe("retry policy: waits, progress and the hourly ceiling", () => {
  const key = "turn-a";

  test("capacity waits follow the schedule and are held per turn until they elapse", () => {
    const policy = new ChatGptWebTurnRetryPolicy();
    const first = policy.planLimitWait(key, { kind: "capacity", budgetMs: 2 * HOUR }, 0);
    expect(first).toEqual({ type: "wait", delayMs: CAPACITY_BACKOFF_MS[0]!, waitedMs: CAPACITY_BACKOFF_MS[0]!, attempt: 1 });
    expect(policy.waitRemainingMs(key, 10_000)).toBe(CAPACITY_BACKOFF_MS[0]! - 10_000);
    expect(policy.waitRemainingMs(key, CAPACITY_BACKOFF_MS[0]!)).toBe(0);
    // Another turn is never held back by this one.
    expect(policy.waitRemainingMs("turn-b", 10_000)).toBe(0);

    const second = policy.planLimitWait(key, { kind: "capacity", budgetMs: 2 * HOUR }, 100_000);
    expect(second).toMatchObject({ type: "wait", delayMs: CAPACITY_BACKOFF_MS[1]!, attempt: 2 });
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs: 2 * HOUR }, 200_000))
      .toMatchObject({ type: "wait", delayMs: CAPACITY_BACKOFF_MS[2]!, attempt: 3 });
  });

  test("the final wait uses what is left of the budget, and then the turn gives up", () => {
    const policy = new ChatGptWebTurnRetryPolicy();
    const budgetMs = 100_000;
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 0)).toMatchObject({ type: "wait", delayMs: 30_000 });
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 40_000)).toMatchObject({ type: "wait", delayMs: 60_000 });
    // 10 s left is too little to be worth a submission.
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 110_000)).toEqual({
      type: "give_up", reason: "budget", waitedMs: 90_000, attempt: 2,
    });
  });

  test("when less than the next delay is left, the last wait uses the remainder", () => {
    const policy = new ChatGptWebTurnRetryPolicy();
    const budgetMs = 130_000;
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 0)).toMatchObject({ delayMs: 30_000 });
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 31_000)).toMatchObject({ delayMs: 60_000 });
    // 40 s of the budget remain but the schedule asks for 120 s: wait the 40 s.
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 100_000)).toMatchObject({ type: "wait", delayMs: 40_000 });
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs }, 150_000)).toMatchObject({ type: "give_up", reason: "budget" });
  });

  test("a stated usage-limit wait is honoured, or refused outright when it cannot fit", () => {
    const policy = new ChatGptWebTurnRetryPolicy();
    expect(policy.planLimitWait(key, { kind: "usage_limit", retryAfterMs: 20 * MINUTE, budgetMs: 2 * HOUR }, 0))
      .toMatchObject({ type: "wait", delayMs: 20 * MINUTE + RETRY_AFTER_MARGIN_MS });
    expect(policy.planLimitWait("turn-b", { kind: "usage_limit", retryAfterMs: 5 * HOUR, budgetMs: 2 * HOUR }, 0))
      .toMatchObject({ type: "give_up", reason: "too_long", waitedMs: 0 });
    expect(policy.waitRemainingMs("turn-b", 1)).toBe(0);
    expect(policy.planLimitWait("turn-c", { kind: "usage_limit", budgetMs: 2 * HOUR }, 0))
      .toMatchObject({ type: "wait", delayMs: USAGE_LIMIT_DEFAULT_WAIT_MS });
  });

  test("a budget of 0 never waits", () => {
    const policy = new ChatGptWebTurnRetryPolicy();
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs: 0 }, 0)).toMatchObject({ type: "give_up", reason: "disabled" });
    expect(policy.waitRemainingMs(key, 1)).toBe(0);
  });

  test("progress resets the failures and the waits of a turn, but not the hourly ceiling", () => {
    const policy = new ChatGptWebTurnRetryPolicy(30 * MINUTE, 6);
    for (let i = 0; i < MAX_CHATGPT_WEB_TURN_RETRIES; i += 1) {
      policy.recordRetryableFailure(key, retryable(), i);
    }
    policy.planLimitWait(key, { kind: "capacity", budgetMs: HOUR }, 10);
    expect(policy.retriesInLastHour(20)).toBe(MAX_CHATGPT_WEB_TURN_RETRIES + 1);
    policy.recordProgress(key);
    expect(policy.waitRemainingMs(key, 20)).toBe(0);
    expect(policy.exhaustedError(key, 20)).toBeUndefined();
    // One more failure is a first failure again, not the fourth.
    expect(policy.recordRetryableFailure(key, retryable(), 30).retryable).toBeTrue();
    // The wait schedule starts over too.
    expect(policy.planLimitWait(key, { kind: "capacity", budgetMs: HOUR }, 40))
      .toMatchObject({ type: "wait", delayMs: CAPACITY_BACKOFF_MS[0]!, attempt: 1 });
    // ...while the hourly ceiling still counts everything.
    expect(policy.retriesInLastHour(50)).toBe(MAX_CHATGPT_WEB_TURN_RETRIES + 3);
  });

  test("without progress the per-turn retry budget is still three", () => {
    const policy = new ChatGptWebTurnRetryPolicy();
    const results = [0, 1, 2, 3].map(i => policy.recordRetryableFailure(key, retryable(), i));
    expect(results.map(result => result.retryable)).toEqual([true, true, true, false]);
    expect(policy.exhaustedError(key, 10)?.message).toContain("remained unavailable after several attempts");
  });

  test("an outage cannot make more than the hourly ceiling of automatic retries, across turns", () => {
    const policy = new ChatGptWebTurnRetryPolicy(30 * MINUTE, 4);
    const at = (minutes: number) => minutes * MINUTE;
    expect(policy.recordRetryableFailure("turn-1", retryable(), at(0)).retryable).toBeTrue();
    expect(policy.recordRetryableFailure("turn-2", retryable(), at(1)).retryable).toBeTrue();
    expect(policy.recordRetryableFailure("turn-3", retryable(), at(2)).retryable).toBeTrue();
    expect(policy.planLimitWait("turn-4", { kind: "capacity", budgetMs: 2 * HOUR }, at(3))).toMatchObject({ type: "wait" });
    // Ceiling reached: neither a retryable failure nor another wait buys a new attempt.
    const capped = policy.recordRetryableFailure("turn-5", retryable(), at(4));
    expect(capped.retryable).toBeFalse();
    expect(capped.message).toContain("paused for the rest of this hour");
    expect(policy.exhaustedError("turn-5", at(5))?.message).toContain("paused for the rest of this hour");
    expect(policy.planLimitWait("turn-6", { kind: "capacity", budgetMs: 2 * HOUR }, at(5)))
      .toMatchObject({ type: "give_up", reason: "hourly_cap" });
    // An hour later the window has moved on.
    expect(policy.recordRetryableFailure("turn-7", retryable(), at(63)).retryable).toBeTrue();
    expect(policy.retriesInLastHour(at(63))).toBeLessThan(4);
  });

  test("a turn that is still waiting is not forgotten by the idle prune", () => {
    const policy = new ChatGptWebTurnRetryPolicy(30 * MINUTE);
    policy.planLimitWait(key, { kind: "usage_limit", retryAfterMs: 90 * MINUTE, budgetMs: 2 * HOUR }, 0);
    expect(policy.waitRemainingMs(key, 80 * MINUTE)).toBeGreaterThan(0);
    // After the wait the usual idle expiry applies again.
    expect(policy.waitRemainingMs(key, 91 * MINUTE + RETRY_AFTER_MARGIN_MS)).toBe(0);
  });

  test("the give-up message says what was done and never retries", () => {
    const original = chatGptModelAtCapacityError();
    const plan = (reason: "disabled" | "budget" | "too_long" | "hourly_cap", waitedMs = 0, attempt = 0) => (
      { type: "give_up" as const, reason, waitedMs, attempt }
    );
    expect(chatGptLimitGiveUpError(original, plan("disabled"), 0)).toBe(original);
    const budget = chatGptLimitGiveUpError(original, plan("budget", 2 * HOUR, 12), 2 * HOUR);
    expect(budget.message).toContain("already waited 2 hours over 12 retries");
    expect(budget.message).toContain("wait budget");
    expect(budget).toMatchObject({ code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: false });
    const tooLong = chatGptLimitGiveUpError(chatGptUsageLimitError(5 * HOUR), plan("too_long"), 2 * HOUR);
    expect(tooLong.message).toContain("longer than the 2 hours");
    expect(tooLong.message).toContain("Try again in 5 hours");
    expect(chatGptLimitGiveUpError(original, plan("hourly_cap", MINUTE, 1), HOUR).message)
      .toContain("paused for the rest of this hour");
  });
});

function retryable(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("ChatGPT is temporarily unavailable.", {
    status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
  });
}
