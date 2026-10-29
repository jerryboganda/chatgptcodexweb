import { ChatGptWebAdapterError } from "./adapter-error";
import {
  chatGptLimitErrorAfterWaiting,
  formatChatGptDuration,
  limitWaitDelayMs,
  type ChatGptLimitKind,
} from "./limit-wait";

/** Maximum number of automatic browser-turn retries after the initial send. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = 3;
/**
 * Rolling-hour ceiling on every automatic re-submission this process makes (retryable failures and
 * limit waits alike, across all turns), so an outage can never hammer the account however many
 * turns are making progress in between failures.
 */
export const MAX_CHATGPT_WEB_RETRIES_PER_HOUR = 20;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;
/** A wait shorter than this cannot clear a limit and is not worth a submission. */
const MIN_USEFUL_LIMIT_WAIT_MS = 30_000;

interface RetryBudgetEntry {
  retries: number;
  /** Retries stopped by the hourly ceiling rather than by this turn's own budget. */
  cappedByHour: boolean;
  /** Milliseconds of limit wait already scheduled for the current stall. */
  waitedMs: number;
  limitWaits: number;
  /** No new browser attempt may start before this instant. */
  notBefore: number;
  updatedAt: number;
  lastError?: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

export type ChatGptLimitWaitGiveUp = "disabled" | "budget" | "too_long" | "hourly_cap";

export type ChatGptLimitWaitPlan =
  | { type: "wait"; delayMs: number; waitedMs: number; attempt: number }
  | { type: "give_up"; reason: ChatGptLimitWaitGiveUp; waitedMs: number; attempt: number };

export interface ChatGptLimitWaitRequest {
  kind: ChatGptLimitKind;
  /** The wait ChatGPT stated, when it stated one. */
  retryAfterMs?: number;
  /** Total time this stalled turn may wait. 0 disables waiting. */
  budgetMs: number;
}

function exhaustedError(entry: RetryBudgetEntry): ChatGptWebAdapterError | undefined {
  const last = entry.lastError;
  if (!last) return undefined;
  return new ChatGptWebAdapterError(
    `${last.message} ${entry.cappedByHour
      ? "Automatic retries are paused for the rest of this hour to protect the account."
      : "ChatGPT remained unavailable after several attempts."}`,
    {
      status: last.status,
      errorType: last.errorType,
      code: last.code,
      retryable: false,
    },
  );
}

/**
 * Tracks only retryable ChatGPT browser failures across adapter instances. The HTTP bridge creates
 * one adapter per request, so this process-local budget must live outside createChatGptWebAdapter.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();
  private attempts: number[] = [];

  constructor(
    private readonly ttlMs = RETRY_BUDGET_TTL_MS,
    private readonly hourlyCap = MAX_CHATGPT_WEB_RETRIES_PER_HOUR,
  ) {}

  recordRetryableFailure(key: string, error: ChatGptWebAdapterError, now = Date.now()): ChatGptWebAdapterError {
    this.prune(now);
    const previous = this.entries.get(key);
    const capped = this.hourlyCapReached(now);
    if (!capped) this.attempts.push(now);
    const entry: RetryBudgetEntry = {
      retries: capped
        ? Math.max((previous?.retries ?? 0) + 1, MAX_CHATGPT_WEB_TURN_RETRIES + 1)
        : (previous?.retries ?? 0) + 1,
      cappedByHour: capped || previous?.cappedByHour === true,
      waitedMs: previous?.waitedMs ?? 0,
      limitWaits: previous?.limitWaits ?? 0,
      notBefore: previous?.notBefore ?? 0,
      updatedAt: now,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    return entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry)! : error;
  }

  exhaustedError(key: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : undefined;
  }

  /**
   * The turn made real progress (a tool round was delivered), so earlier failures no longer count
   * against it. The rolling-hour ceiling is deliberately not reset by progress.
   */
  recordProgress(key: string): void {
    this.entries.delete(key);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Decide whether a capacity/usage-limit failure should be waited out. A "wait" schedules the delay
   * for this turn key: every attempt for that key, including a reconnect of the same native turn, is
   * held back until it has elapsed, so a reconnect cannot skip the wait.
   */
  planLimitWait(key: string, request: ChatGptLimitWaitRequest, now = Date.now()): ChatGptLimitWaitPlan {
    this.prune(now);
    const entry = this.entries.get(key);
    const waitedMs = entry?.waitedMs ?? 0;
    const attempt = (entry?.limitWaits ?? 0) + 1;
    const giveUp = (reason: ChatGptLimitWaitGiveUp): ChatGptLimitWaitPlan => (
      { type: "give_up", reason, waitedMs, attempt: attempt - 1 }
    );
    if (request.budgetMs <= 0) return giveUp("disabled");
    const remaining = request.budgetMs - waitedMs;
    let delayMs = limitWaitDelayMs(request.kind, entry?.limitWaits ?? 0, request.retryAfterMs);
    // Waiting less than ChatGPT said cannot succeed, so a stated wait beyond the budget ends it now.
    if (request.retryAfterMs !== undefined && delayMs > remaining) return giveUp("too_long");
    if (remaining < MIN_USEFUL_LIMIT_WAIT_MS) return giveUp("budget");
    delayMs = Math.min(delayMs, remaining);
    if (this.hourlyCapReached(now)) return giveUp("hourly_cap");
    this.attempts.push(now);
    this.entries.set(key, {
      retries: entry?.retries ?? 0,
      cappedByHour: entry?.cappedByHour ?? false,
      waitedMs: waitedMs + delayMs,
      limitWaits: attempt,
      notBefore: now + delayMs,
      // An entry that is still waiting must not be pruned for being idle.
      updatedAt: now + delayMs,
      ...(entry?.lastError ? { lastError: entry.lastError } : {}),
    });
    return { type: "wait", delayMs, waitedMs: waitedMs + delayMs, attempt };
  }

  /** Milliseconds until a new browser attempt for this key may start; 0 when none is held back. */
  waitRemainingMs(key: string, now = Date.now()): number {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.notBefore - now) : 0;
  }

  /** Re-submissions made in the last hour, for logs and tests. */
  retriesInLastHour(now = Date.now()): number {
    this.pruneAttempts(now);
    return this.attempts.length;
  }

  private hourlyCapReached(now: number): boolean {
    this.pruneAttempts(now);
    return this.attempts.length >= this.hourlyCap;
  }

  private pruneAttempts(now: number): void {
    const cutoff = now - HOUR_MS;
    if (this.attempts.length > 0 && this.attempts[0]! <= cutoff) {
      this.attempts = this.attempts.filter(at => at > cutoff);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }
}

/** What a caller reports when the plan says to stop: the original failure plus what was already done. */
export function chatGptLimitGiveUpError(
  error: ChatGptWebAdapterError,
  plan: Extract<ChatGptLimitWaitPlan, { type: "give_up" }>,
  budgetMs: number,
): ChatGptWebAdapterError {
  const waited = plan.waitedMs > 0
    ? `The bridge already waited ${formatChatGptDuration(plan.waitedMs)} over ${plan.attempt} ${plan.attempt === 1 ? "retry" : "retries"}. `
    : "";
  switch (plan.reason) {
    case "disabled":
      // Waiting was switched off on purpose; say nothing about it.
      return error;
    case "too_long":
      return chatGptLimitErrorAfterWaiting(error, `${waited}That is longer than the ${formatChatGptDuration(budgetMs)} the bridge is allowed to wait, so it is not waiting.`);
    case "hourly_cap":
      return chatGptLimitErrorAfterWaiting(error, `${waited}Automatic retries are paused for the rest of this hour to protect the account.`);
    case "budget":
      return chatGptLimitErrorAfterWaiting(error, `${waited}The ${formatChatGptDuration(budgetMs)} wait budget for this turn is used up.`);
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();
