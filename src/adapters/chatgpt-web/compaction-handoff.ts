import { parseDataUrl } from "../image";
import type {
  CodexContentPart,
  CodexParsedRequest,
  CodexToolResultMessage,
} from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { isReadableCompactionSummaryText } from "../../responses/compaction";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";
import { buildTaskLedger, stripTaskLedger } from "./task-ledger";

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function withZeroRiskCompactionInstruction(result: BrokerToolResult): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(true),
      },
    ],
  };
}

function interruptedByZeroRiskCompaction(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: zeroRiskActiveCompactionToolResultInstruction(false),
    }],
    isError: true,
  };
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

// Plain-text markers on their own lines: ChatGPT renders angle-bracket tags as HTML and drops them
// from the copied answer, so a tag cannot carry a block through a fresh summarizer chat.
const STANDING_BLOCK = /^[^\w\n]*STANDING_INSTRUCTIONS_BEGIN[^\w\n]*\r?\n([\s\S]*?)^[^\w\n]*STANDING_INSTRUCTIONS_END[^\w\n]*$/m;
const standingBlock = (body: string): string => `STANDING_INSTRUCTIONS_BEGIN\n${body}\nSTANDING_INSTRUCTIONS_END`;
const STANDING_BLOCK_MAX_CHARS = 20_000;

function standingLineCovered(line: string, currentText: string): boolean {
  const flat = (value: string) => value.replace(/^[-*•\d.)\s]+/, "").replace(/\s+/g, " ").toLowerCase();
  if (currentText.includes(flat(line))) return true;
  // A rephrased line is still covered when every identifier or code in it is present.
  const identifiers = (line.match(/[A-Za-z0-9][A-Za-z0-9._/\:-]{2,}/g) ?? [])
    .map(token => token.replace(/[.,;:)]+$/, ""))
    .filter(token => /[0-9_/\:-]/.test(token));
  return identifiers.length > 0 && identifiers.every(token => currentText.includes(token.toLowerCase()));
}

/**
 * A checkpoint writer sometimes drops a rule or code that an earlier checkpoint listed, and each
 * later checkpoint can only carry what the previous one kept. The standing-instructions block of the
 * previous checkpoint is therefore merged into the new one: lines are only ever added, never removed.
 */
export function carryForwardStandingInstructions(summary: string, priorSummary: string | undefined): string {
  const prior = priorSummary?.match(STANDING_BLOCK)?.[1];
  if (!prior) return summary;
  const current = summary.match(STANDING_BLOCK);
  const currentText = (current?.[1] ?? "").replace(/\s+/g, " ").toLowerCase();
  const missing = prior.split("\n").map(line => line.trim()).filter(Boolean)
    .filter(line => !standingLineCovered(line, currentText));
  if (missing.length === 0) return summary;
  const addition = missing.join("\n");
  if (!current) return `${standingBlock(addition)}\n\n${summary}`;
  if (current[1]!.length + addition.length > STANDING_BLOCK_MAX_CHARS) return summary;
  return summary.replace(
    STANDING_BLOCK,
    (_match, body: string) => standingBlock(`${body.trimEnd()}\n${addition}`),
  );
}

function latestPriorCheckpointText(parsed: CodexParsedRequest): string | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index]!;
    if (message.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    if (isReadableCompactionSummaryText(text)) return text;
  }
  return undefined;
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const trimmed = summary.trim();
  if (!trimmed) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const prior = latestPriorCheckpointText(parsed);
  // The ledger is rebuilt from the canonical history on every checkpoint. Whatever the model wrote
  // for it (an echo of the previous ledger, a partial copy) is discarded, and the merged standing
  // instructions move out of the model's text into the ledger so trimming a summary cannot lose them.
  const merged = carryForwardStandingInstructions(stripTaskLedger(trimmed), prior);
  const standing = merged.match(STANDING_BLOCK);
  const body = standing ? merged.replace(STANDING_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim() : merged;
  const ledger = buildTaskLedger({ parsed, standingBody: standing?.[1], priorCheckpoint: prior });
  const normalized = [ledger, body].filter(Boolean).join("\n\n");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset < 0) return `${normalized}\n\n${appendix}`;
  if (normalized.slice(markerOffset + 1).trimEnd() !== appendix) {
    throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
  }
  return normalized;
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;

export const COMPACTION_HANDOFF_TIMEOUT_CODE = "compaction_handoff_timeout";

export function compactionHandoffTimeoutError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 409,
    errorType: "invalid_request_error",
    code: COMPACTION_HANDOFF_TIMEOUT_CODE,
    retryable: false,
  });
}

function boundedCompactionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction(), () => source.runtime.trace.recordProgress());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(
          token,
          request.callId,
          toolResult(result),
        );
        source.runtime.externalProgress.recordToolResult();
        source.runtime.trace.recordProgress();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      // The one structured checkpoint message reuses this exact retained tab. It must not race the
      // helper's /turn/end handshake for the response that consumed the canonical tool results.
      // `requestCompaction` leaves those results untouched and only intercepts a later tool call, so
      // a zero delivery count proves that this is an ordinary publishable terminal response.
      await withCompactionAbort(source.physicalSettlement, signal);
      return {
        answer: browserOutcome.answer,
        compactionInstructionDelivered,
      };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function settleActiveZeroRiskCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBrokerOwner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.runtime.manualControl) {
      throw new Error("The active Zero Risk compaction source has no manual MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for Zero Risk compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      const interruptedQueued = await broker.requestCompaction(
        token,
        interruptedByZeroRiskCompaction(),
      );
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId)!;
        const canonical = toolResult(result);
        await broker.completeTool(
          token,
          request.callId,
          interruptedQueued === 0 && index === outstanding.length - 1
            ? withZeroRiskCompactionInstruction(canonical)
            : canonical,
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      await withCompactionAbort(source.physicalSettlement, signal);
      const instructionDelivered = outstanding.length > 0
        || await broker.compactionDeliveryCount(token) > 0;
      if (!instructionDelivered) return undefined;
      const summary = browserOutcome.answer.trim();
      if (!summary) throw new Error("The active Zero Risk response returned an empty compaction summary");
      return summary;
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = boundedCompactionTimeout(timeoutMs);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    // A typed failure, so the caller can fall back to a fresh-chat summary instead of failing compaction.
    () => deadline.abort(compactionHandoffTimeoutError(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  deadlineTimer.unref?.();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: CompactionTransactionHandle | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(lateTransaction => {
      if (operationSignal.aborted && transaction !== lateTransaction) {
        broker.abortCompactionTransaction(lateTransaction.token);
      }
    }, () => {});
    transaction = await withCompactionAbort(transactionPromise, operationSignal);
    const instruction = structuredCompactionHandoffInstruction(transaction, worker.appName);
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      // The retained connector exposes only the one-shot control token embedded above. It does
      // not receive an ordinary Codex tool environment for this checkpoint message.
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      // A response that finishes without calling the control tool must leave the conversation
      // available for one more request; an accepted handoff aborts the turn and never retains it.
      retainConversation: true,
      compaction: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    const handoff = broker.waitForCompactionHandoff(transaction.token, operationSignal);
    const browserWithoutHandoff = browser.then<never>(answer => {
      // The control handler accepts the summary before replying to ChatGPT. A fully
      // settled response without that receipt cannot become a successful checkpoint.
      console.warn(`[chatgpt-web] compaction_handoff_missing ${JSON.stringify({
        traceId, answerChars: answer.length, answer: answer.slice(0, 300),
      })}`);
      // ChatGPT's own safety layer can block the control call because of what the summary says
      // (for example a credential-looking value). Asking again in the same chat is blocked the same way.
      const blocked = /safety checks/i.test(answer);
      throw new ChatGptWebAdapterError(
        blocked
          ? "ChatGPT's safety checks blocked the context summary from reaching Codex."
          : "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
        {
          status: 409,
          errorType: "invalid_request_error",
          code: blocked ? "compaction_handoff_blocked" : "compaction_handoff_missing",
          retryable: false,
        },
      );
    });
    const summary = await withCompactionAbort(
      Promise.race([
        handoff,
        browserWithoutHandoff,
      ]),
      operationSignal,
    );
    // The one-shot control submission is the terminal event for this purpose-built response.
    // ChatGPT may render no assistant text after a tool-only response, and therefore no Copy
    // action. End our owned turn explicitly and wait for the launcher/helper cleanup handshake.
    browserAbort.abort(new ChatGptCompactionHandoffAccepted());
    await withCompactionAbort(
      browser.then(() => undefined, () => undefined),
      operationSignal,
    );
    return summary;
  } finally {
    browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    if (browser) {
      // Logical cancellation is not physical retirement. The retained-session owner tracks
      // physical settlement separately, so this helper must not turn its own deadline into an
      // unbounded wait when the worker does not acknowledge abort immediately.
      await withCompactionAbort(
        browser.then(() => undefined, () => undefined),
        operationSignal,
      ).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(deadlineTimer);
  }
}

/** A retained source may finish a checkpoint request without calling the control tool, so ask once more. A safety block is final. */
export const MAX_RETAINED_COMPACTION_HANDOFF_ATTEMPTS = 2;

/**
 * Asks the retained ChatGPT conversation for its checkpoint, repeating the one-shot request in the
 * same conversation when ChatGPT answers without submitting it. Retiring the retained chat after one
 * miss forces a fresh summarizer to ingest the complete history, which can exceed ChatGPT's window
 * and fail the whole Codex task. Timeouts, cancellation and every other error are never retried.
 */
export async function requestRetainedCompactionHandoffWithRetry(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  onRetry?: () => void,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestRetainedCompactionHandoff(
        worker,
        parsed,
        source,
        broker,
        capabilities,
        attempt === 1 ? traceId : `${traceId}_retry${attempt - 1}`,
        signal,
        timeoutMs,
      );
    } catch (error) {
      if (
        attempt >= MAX_RETAINED_COMPACTION_HANDOFF_ATTEMPTS
        || signal?.aborted
        || !(error instanceof ChatGptWebAdapterError)
        || error.code !== "compaction_handoff_missing"
      ) throw error;
      console.warn(`[chatgpt-web] compaction_handoff_retry ${JSON.stringify({ traceId, attempt })}`);
      onRetry?.();
    }
  }
}

interface CachedCompactionRun {
  createdAt: number;
  ownerKey: string;
  traceIds: ReadonlySet<string>;
  nativeThreadId?: string;
  nativeTurnId?: string;
  abort: AbortController;
  active: boolean;
  promise: Promise<string>;
  settlement: Promise<void>;
}

interface StructuredCompactionInterruption {
  createdAt: number;
  reason: Error;
}

export interface StructuredCompactionOwner {
  ownerKey: string;
  /** Every externally addressable browser trace owned by this structured compaction. */
  traceIds: readonly string[];
  /** Exact native Codex owner, when supplied by the current Responses request. */
  nativeThreadId?: string;
  nativeTurnId?: string;
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const structuredCompactionOwners = new Map<string, Promise<void>>();
const structuredCompactionInterruptions = new Map<string, StructuredCompactionInterruption>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

function nativeTurnIdentityKey(threadId: string, turnId: string): string {
  if (!threadId.trim() || !turnId.trim()) {
    throw new Error("Structured compaction requires non-empty native thread and turn ids");
  }
  return JSON.stringify([threadId, turnId]);
}

function rememberStructuredCompactionInterruption(threadId: string, turnId: string, reason: Error): void {
  const identity = nativeTurnIdentityKey(threadId, turnId);
  const now = Date.now();
  pruneStructuredCompactionInterruptions(now);
  const existing = structuredCompactionInterruptions.get(identity);
  if (existing) {
    existing.createdAt = now;
    return;
  }
  structuredCompactionInterruptions.set(identity, { createdAt: now, reason });
}

function structuredCompactionInterruption(owner: StructuredCompactionOwner): Error | undefined {
  if (owner.nativeThreadId === undefined && owner.nativeTurnId === undefined) return undefined;
  pruneStructuredCompactionInterruptions();
  return structuredCompactionInterruptions.get(
    nativeTurnIdentityKey(owner.nativeThreadId ?? "", owner.nativeTurnId ?? ""),
  )?.reason;
}

function pruneStructuredCompactionInterruptions(now = Date.now()): void {
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [identity, interruption] of structuredCompactionInterruptions) {
    if (interruption.createdAt < cutoff) structuredCompactionInterruptions.delete(identity);
  }
}

function pruneStructuredCompactionRuns(): void {
  const now = Date.now();
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [candidate, run] of structuredCompactionRuns) {
    if (!run.active && run.createdAt < cutoff) structuredCompactionRuns.delete(candidate);
  }
  pruneStructuredCompactionInterruptions(now);
}

/** Return the canonical result of an exact compact request, even after its source was retired. */
export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(
  key: string,
  owner: StructuredCompactionOwner,
  start: (operatorSignal: AbortSignal, retainOwnershipUntil: (settlement: Promise<void>) => void) => Promise<string>,
): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  const interrupted = structuredCompactionInterruption(owner);
  if (interrupted) return Promise.reject(interrupted);
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const physicalSettlements: Promise<void>[] = previousOwner ? [previousOwner] : [];
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal, settlement => { physicalSettlements.push(settlement); });
  });
  // Return a deadline failure promptly, while its physical browser owner still blocks retries
  // and cancel-all completion. A cancelled queued run must also retain its predecessor's gate.
  const ownerSettlement = promise.then(() => false, error => {
    // Native retries of the identical oversized input cannot fix a size rejection. Replay that
    // terminal result under the existing cache lifetime; reduced input/model changes get a new key.
    return !(error instanceof ChatGptWebAdapterError
      && error.code === "context_length_exceeded" && !error.retryable);
  }).then(async evict => {
    await Promise.allSettled(physicalSettlements);
    run.active = false;
    if (structuredCompactionOwners.get(owner.ownerKey) === ownerSettlement) {
      structuredCompactionOwners.delete(owner.ownerKey);
    }
    if (evict && structuredCompactionRuns.get(key) === run) structuredCompactionRuns.delete(key);
  });
  const run: CachedCompactionRun = {
    createdAt: Date.now(),
    ownerKey: owner.ownerKey,
    traceIds: new Set(owner.traceIds),
    ...(owner.nativeThreadId ? { nativeThreadId: owner.nativeThreadId } : {}),
    ...(owner.nativeTurnId ? { nativeTurnId: owner.nativeTurnId } : {}),
    abort,
    active: true,
    promise,
    settlement: ownerSettlement,
  };
  structuredCompactionRuns.set(key, run);
  structuredCompactionOwners.set(owner.ownerKey, ownerSettlement);
  return promise;
}

function beginCancelStructuredCompactionRuns(
  matches: (run: CachedCompactionRun) => boolean,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  const runs = [...structuredCompactionRuns.values()].filter(run => run.active && matches(run));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return { cancelled: runs.length, settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined) };
}

/** Begin cancelling the structured compaction owned by one exact native Codex turn. */
export function cancelStructuredCompactionNativeTurn(
  threadId: string,
  turnId: string,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  // Record before scanning active owners. Registration and cancellation share this synchronous
  // boundary, so either registration wins and is aborted below, or interruption wins and the later
  // registration rejects without invoking its detached work.
  rememberStructuredCompactionInterruption(threadId, turnId, reason);
  const runs = [...structuredCompactionRuns.values()].filter(run => (
    run.active
    && run.nativeThreadId === threadId
    && run.nativeTurnId === turnId
  ));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return {
    cancelled: runs.length,
    settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined),
  };
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function beginCancelStructuredCompactionTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
  return beginCancelStructuredCompactionRuns(run => run.traceIds.has(traceId), reason);
}

export async function cancelStructuredCompactionTrace(traceId: string, reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionTrace(traceId, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}

/** Cancel every active compaction owner and wait for its browser/helper cleanup. */
export async function cancelAllStructuredCompactions(reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionRuns(() => true, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}
