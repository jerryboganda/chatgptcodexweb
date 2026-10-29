export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function chatGptToolTimeoutError(tool: string, timeoutMs: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `Codex tool ${tool} did not return a result within ${timeoutMs / 1_000} seconds. `
    + "The turn was stopped. Check whether the command is still running or waiting for approval before retrying.",
    { status: 504, errorType: "server_error", code: "codex_tool_timeout", retryable: false },
  );
}

export function chatGptResponseIncompleteError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502, errorType: "server_error", code: "chatgpt_response_incomplete", retryable: false,
  });
}

export function chatGptToolApprovalRequiredError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT is waiting for plugin permission. Open the plugin's settings in ChatGPT, "
    + 'then Permissions → Allow all actions, and retry this turn.',
    { status: 403, errorType: "permission_error", code: "chatgpt_tool_approval_required", retryable: false },
  );
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

/**
 * The browser worker saw its own page disappear. This is the same terminal `client_cancelled` error
 * as a closed tab until the launcher's end-of-turn handshake proves that no user closed the tab
 * (`cancelledByUser: false`); only then is it converted into {@link chatGptBrowserSurfaceLostError}.
 * Only the page-closed observation sites in the browser worker may construct this marker.
 */
export class ChatGptBrowserPageClosedError extends ChatGptWebAdapterError {
  constructor() {
    super("The ChatGPT browser tab was closed, so the Codex turn was cancelled.", {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    });
    this.name = "ChatGptBrowserPageClosedError";
  }
}

export function chatGptBrowserPageClosedError(): ChatGptWebAdapterError {
  return new ChatGptBrowserPageClosedError();
}

export const CHATGPT_SURFACE_LOST_CODE = "chatgpt_surface_lost";

/**
 * The launcher surface disappeared (renderer crash, failed navigation, expired lease) without a
 * user cancelling it. The old chat is discarded; a retry rebuilds a new chat from the complete
 * canonical history, so it can never double-submit into the lost conversation.
 */
export function chatGptBrowserSurfaceLostError(cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser surface was lost before the response finished, and no one closed it. "
    + "The turn can be retried in a new chat that carries the complete task history.",
    {
      status: 503,
      errorType: "server_error",
      code: CHATGPT_SURFACE_LOST_CODE,
      retryable: true,
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

/** Playwright wording for a page, context or browser that went away underneath an in-flight call. */
const CLOSED_BROWSER_TARGET = /\b(?:target (?:page, context or browser has been closed|closed|crashed)|page crashed|(?:page|browser|context) has been closed|browser (?:has )?closed)\b/i;

export function isChatGptClosedBrowserTargetError(error: unknown): boolean {
  if (error instanceof ChatGptWebAdapterError) return false;
  return error instanceof Error && CLOSED_BROWSER_TARGET.test(error.message);
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
