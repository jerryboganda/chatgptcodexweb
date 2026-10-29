import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * ChatGPT tells an account two different things that a person would simply wait out:
 * the selected model is at capacity, or the account used up a usage limit. Neither one is helped
 * by Codex retrying a moment later, so the bridge classifies them, applies a bounded wait itself and
 * rebuilds the turn in a new chat afterwards. Everything here is pure text/number logic; the browser
 * worker supplies the text of a visible ChatGPT alert and the adapter applies the wait.
 */
export type ChatGptLimitKind = "capacity" | "usage_limit";

export const CHATGPT_MODEL_AT_CAPACITY_CODE = "chatgpt_model_at_capacity";
export const CHATGPT_USAGE_LIMIT_CODE = "chatgpt_usage_limit_reached";

/** Total time one stalled turn may spend waiting out capacity or usage limits. 0 disables waiting. */
export const DEFAULT_LIMIT_WAIT_BUDGET_MS = 2 * 60 * 60_000;
const MAX_LIMIT_WAIT_BUDGET_MS = 24 * 60 * 60_000;
/** A parsed "try again in ..." beyond this is treated as this long; the budget decides what to do. */
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60_000;

export const LIMIT_WAIT_MINUTES_ENV = "CODEX_CHATGPT_WEB_LIMIT_WAIT_MINUTES";

/** A model at capacity usually clears within minutes; the last delay repeats. */
export const CAPACITY_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];
/** Used when ChatGPT reports a usage limit without saying when it clears. */
export const USAGE_LIMIT_DEFAULT_WAIT_MS = 15 * 60_000;
/** Added to a time ChatGPT states, so the retry does not land on the exact boundary. */
export const RETRY_AFTER_MARGIN_MS = 30_000;

export interface ChatGptLimitClassification {
  kind: ChatGptLimitKind;
  /** The wait ChatGPT itself stated ("try again in 2 hours"), when it stated one. */
  retryAfterMs?: number;
}

const compact = (text: string): string => text.replace(/\s+/g, " ").trim();

const CAPACITY_PATTERNS: readonly RegExp[] = [
  /\bat capacity\b/i,
  /\b(?:model|gpt)\b[^.!?\n]{0,60}\b(?:over ?capacity|overloaded)\b/i,
  /\b(?:over ?capacity|overloaded)\b[^.!?\n]{0,60}\bmodel\b/i,
  /\bexperiencing (?:unusually |very |extremely )?high (?:demand|volume|traffic)\b/i,
];

const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b(?:limit|limits|cap|quota)\b[^.!?\n]{0,30}\b(?:has been |have been |was |is |are )?(?:reached|exceeded|hit|used up)\b/i,
  /\b(?:reached|hit|exceeded|used up|run out of|ran out of)\b[^.!?\n]{0,80}\b(?:limit|limits|cap|quota|usage|messages)\b/i,
];

// A bare "usage limit" is marketing copy as often as it is a failure; it counts only together with
// the "try again in ..." time that a real limit notice states.
const BARE_USAGE_LIMIT = /\b(?:usage|message|messages|hourly|daily|weekly|monthly) (?:limit|limits|cap)\b/i;

// These belong to other, already classified failures or are only warnings, and must never become a
// wait: the burst-throttle dialog (a deliberate hard stop), file-upload limits, size rejections, and
// "you are about to reach your limit" notices shown while a response is still being produced.
const NOT_A_USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /too many requests|making requests too quickly|requests too quickly/i,
  /\b(?:upload|uploads|attachment|attachments|file|files|image|images)\b[^.!?\n]{0,40}\b(?:limit|quota|cap)\b/i,
  /\b(?:limit|quota|cap)\b[^.!?\n]{0,40}\b(?:upload|uploads|attachment|attachments|files|images)\b/i,
  /too long|context (?:window|length)|exceeds? (?:the )?(?:max|maximum)/i,
  /\b(?:approaching|nearing|almost|nearly|about to|close to|before you (?:hit|reach)|until you (?:hit|reach)|if you (?:hit|reach))\b/i,
];

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:d|day|days)$/, 86_400_000],
  [/^(?:h|hr|hrs|hour|hours)$/, 3_600_000],
  [/^(?:m|min|mins|minute|minutes)$/, 60_000],
  [/^(?:s|sec|secs|second|seconds)$/, 1_000],
];

const RETRY_TRIGGER = /\b(?:try again|retry|come back|check back|available again|resets?|wait)\s+(?:again\s+)?(?:in|after|within|for)\s+/;
const APPROXIMATION = /^(?:about|around|approximately|roughly|at least|less than|just over|over|~)\s*/;

/**
 * "Try again in 2 hours 5 minutes", "in about 45 minutes", "in 1h 20m", "in an hour" -> milliseconds.
 * Returns undefined when the text states no duration (including absolute clock times, which cannot
 * be converted reliably), so the caller falls back to its own schedule.
 */
export function parseChatGptRetryAfterMs(text: string | undefined): number | undefined {
  const lower = compact(text ?? "").toLowerCase();
  const trigger = RETRY_TRIGGER.exec(lower);
  if (!trigger) return undefined;
  let rest = lower.slice(trigger.index + trigger[0].length).replace(APPROXIMATION, "");
  let total = 0;
  for (;;) {
    const match = /^(\d+(?:\.\d+)?|an?)\s*([a-z]+)(?:\s*(?:,|and)?\s*)?/.exec(rest);
    if (!match) break;
    const unit = UNIT_MS.find(([pattern]) => pattern.test(match[2]!));
    if (!unit) break;
    const quantity = match[1] === "a" || match[1] === "an" ? 1 : Number(match[1]);
    if (!Number.isFinite(quantity)) break;
    total += quantity * unit[1];
    rest = rest.slice(match[0].length);
  }
  if (total <= 0) return undefined;
  return Math.min(Math.round(total), MAX_RETRY_AFTER_MS);
}

/** "2 hours 5 minutes". Rounds up to whole minutes so a re-parse never waits less than stated. */
export function formatChatGptDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days} day${days === 1 ? "" : "s"}` : "",
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Classify text that ChatGPT's own UI displayed as an alert, dialog or response error.
 * Never pass assistant Markdown: an answer that merely discusses "capacity" is not a failure.
 */
export function classifyChatGptLimitText(text: string | undefined): ChatGptLimitClassification | undefined {
  const flat = compact(text ?? "");
  if (!flat || flat.length > 2_000) return undefined;
  const retryAfterMs = parseChatGptRetryAfterMs(flat);
  const withHint = (kind: ChatGptLimitKind): ChatGptLimitClassification => (
    retryAfterMs !== undefined ? { kind, retryAfterMs } : { kind }
  );
  if (CAPACITY_PATTERNS.some(pattern => pattern.test(flat))) return withHint("capacity");
  if (NOT_A_USAGE_LIMIT_PATTERNS.some(pattern => pattern.test(flat))) return undefined;
  if (USAGE_LIMIT_PATTERNS.some(pattern => pattern.test(flat))) return withHint("usage_limit");
  if (retryAfterMs !== undefined && BARE_USAGE_LIMIT.test(flat)) return withHint("usage_limit");
  return undefined;
}

function tryAgainSentence(retryAfterMs: number | undefined): string {
  return retryAfterMs !== undefined ? ` Try again in ${formatChatGptDuration(retryAfterMs)}.` : "";
}

export function chatGptModelAtCapacityError(retryAfterMs?: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT reports that the selected model is at capacity right now. This usually clears within minutes.${tryAgainSentence(retryAfterMs)}`,
    // Not retryable by Codex: a quick client retry cannot help a model that stays at capacity. The
    // bridge owns the (bounded) retry, and a final failure stays sticky for this turn.
    { status: 503, errorType: "server_error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: false },
  );
}

export function chatGptUsageLimitError(retryAfterMs?: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT reports that this account reached a usage limit for the selected model.${
      retryAfterMs !== undefined ? tryAgainSentence(retryAfterMs) : " ChatGPT did not say when it clears."}`,
    { status: 429, errorType: "rate_limit_error", code: CHATGPT_USAGE_LIMIT_CODE, retryable: false },
  );
}

export function chatGptLimitError(classification: ChatGptLimitClassification): ChatGptWebAdapterError {
  return classification.kind === "capacity"
    ? chatGptModelAtCapacityError(classification.retryAfterMs)
    : chatGptUsageLimitError(classification.retryAfterMs);
}

export function chatGptLimitKindOfError(error: unknown): ChatGptLimitKind | undefined {
  if (!(error instanceof ChatGptWebAdapterError)) return undefined;
  if (error.code === CHATGPT_MODEL_AT_CAPACITY_CODE) return "capacity";
  if (error.code === CHATGPT_USAGE_LIMIT_CODE) return "usage_limit";
  return undefined;
}

/**
 * The wait ChatGPT stated is carried in the error message, not in a side channel, so it survives the
 * browser helper's process boundary (which transports only message, status, type, code and flag).
 */
export function chatGptRetryAfterMsOfError(error: ChatGptWebAdapterError): number | undefined {
  return parseChatGptRetryAfterMs(error.message);
}

/** The same failure, reworded to say what the bridge already did about it. */
export function chatGptLimitErrorAfterWaiting(
  error: ChatGptWebAdapterError,
  detail: string,
): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`${error.message} ${detail}`, {
    status: error.status,
    errorType: error.errorType,
    code: error.code,
    retryable: false,
  });
}

export function limitWaitDelayMs(
  kind: ChatGptLimitKind,
  /** Zero-based count of waits already taken for this stalled turn. */
  priorWaits: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return retryAfterMs + RETRY_AFTER_MARGIN_MS;
  if (kind === "usage_limit") return USAGE_LIMIT_DEFAULT_WAIT_MS;
  return CAPACITY_BACKOFF_MS[Math.min(Math.max(0, priorWaits), CAPACITY_BACKOFF_MS.length - 1)]!;
}

/**
 * Wait budget in milliseconds. The environment override wins (a supervisor can set it for the bridge
 * it starts), then the provider setting, then the default. 0 disables waiting entirely.
 */
export function resolveLimitWaitBudgetMs(
  configuredMs?: unknown,
  env: Record<string, string | undefined> = process.env,
): number {
  const fromEnv = env[LIMIT_WAIT_MINUTES_ENV]?.trim();
  if (fromEnv) {
    const minutes = Number(fromEnv);
    if (Number.isFinite(minutes) && minutes >= 0) {
      return Math.min(Math.round(minutes * 60_000), MAX_LIMIT_WAIT_BUDGET_MS);
    }
  }
  if (typeof configuredMs === "number" && Number.isFinite(configuredMs) && configuredMs >= 0) {
    return Math.min(Math.round(configuredMs), MAX_LIMIT_WAIT_BUDGET_MS);
  }
  return DEFAULT_LIMIT_WAIT_BUDGET_MS;
}

/** Sleeps, and rejects with `abortError()` the moment the signal fires; never leaks its timer. */
export function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
  abortError: (signal: AbortSignal) => Error,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
