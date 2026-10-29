import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mock } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import {
  CHATGPT_MODEL_AT_CAPACITY_CODE,
  CHATGPT_USAGE_LIMIT_CODE,
  LIMIT_WAIT_MINUTES_ENV,
  RETRY_AFTER_MARGIN_MS,
  chatGptModelAtCapacityError,
  chatGptUsageLimitError,
} from "../src/adapters/chatgpt-web/limit-wait";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import { chatGptTurnSessions, chatGptTurnRetryKey } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const root = join(tmpdir(), `codex-chatgpt-limit-adapter-${process.pid}-${Date.now()}`);
beforeAll(() => mkdirSync(root, { recursive: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const savedEnv = process.env[LIMIT_WAIT_MINUTES_ENV];
beforeAll(() => { delete process.env[LIMIT_WAIT_MINUTES_ENV]; });
afterAll(() => {
  if (savedEnv === undefined) delete process.env[LIMIT_WAIT_MINUTES_ENV];
  else process.env[LIMIT_WAIT_MINUTES_ENV] = savedEnv;
});
afterEach(() => {
  mock.timers.reset();
  chatGptTurnSessions.clear();
});

type RunFn = (turn: BrowserTurn) => Promise<string>;
let sequence = 0;

function brokerEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function setup(
  extra: NonNullable<CodexProviderConfig["chatgptWeb"]> = {},
  localTools = false,
): { id: string; provider: CodexProviderConfig; worker: ChatGptBrowserWorker; restore: () => Promise<void>; setRun: (run: RunFn) => void } {
  const id = `limit-${process.pid}-${Date.now()}-${sequence += 1}`;
  const brokerSocketPath = brokerEndpoint(`cgw-${id}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://${id}`,
    chatgptWeb: {
      brokerSocketPath, localToolsEnabled: localTools, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      ...extra,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  return {
    id, provider, worker,
    setRun: run => { (worker as unknown as { run: RunFn }).run = run; },
    restore: async () => {
      (worker as unknown as { run: RunFn }).run = originalRun;
      await TurnBroker.forSocket(brokerSocketPath).close();
    },
  };
}

function turnRequest(id: string, text = "Inspect the project"): CodexParsedRequest {
  const turnId = `turn_${id}`;
  const threadId = `thread_${id}`;
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  };
}

const flush = async (rounds = 40): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
};
const heartbeats = (events: AdapterEvent[]): number => events.filter(event => event.type === "heartbeat").length;
const contentEvents = (events: AdapterEvent[]): AdapterEvent[] => events.filter(event => event.type !== "heartbeat");

/** A browser turn that was submitted and then refused by ChatGPT. */
async function submitThenFail(turn: BrowserTurn, error: Error): Promise<never> {
  await turn.onSendActivated?.();
  await turn.onSubmitted?.();
  throw error;
}

async function succeed(turn: BrowserTurn, answer = "Recovered answer"): Promise<string> {
  await turn.onSendActivated?.();
  await turn.onSubmitted?.();
  turn.onTextDelta(answer);
  return answer;
}

describe("a capacity or usage-limit failure is waited out by the bridge", () => {
  test("the model at capacity: the client sees only keep-alives, then the answer from a new chat with the same full prompt", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    const prompts: string[] = [];
    const retained: unknown[] = [];
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      prompts.push((await turn.prepare()).text);
      retained.push(turn.prepareResume, turn.requireRetainedConversation, turn.conversationKey);
      if (starts === 1) return await submitThenFail(turn, chatGptModelAtCapacityError());
      return await succeed(turn);
    });
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const events: AdapterEvent[] = [];
    try {
      const run = createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      await flush();
      expect(starts).toBe(1);
      expect(events.some(event => event.type === "error")).toBeFalse();
      const quietBefore = heartbeats(events);

      // Nothing restarts early, and the stream stays alive with keep-alives the whole time.
      mock.timers.tick(25_000);
      await flush();
      expect(starts).toBe(1);
      expect(heartbeats(events)).toBeGreaterThan(quietBefore);
      expect(events.some(event => event.type === "error")).toBeFalse();

      mock.timers.tick(5_001);
      await flush();
      await run;
      expect(starts).toBe(2);
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(events.filter(event => event.type === "text_delta" && event.text === "Recovered answer")).toHaveLength(1);
      // The retry is a new chat built from the complete canonical history, never a resume of the old one.
      expect(prompts[1]).toBe(prompts[0]!);
      expect(retained.every(value => value === undefined)).toBeTrue();
      // The notice that is shown at the start of every read-only turn is shown once, not twice.
      expect(events.filter(event => event.type === "text_delta" && event.text.includes("Local tools unavailable"))).toHaveLength(1);
    } finally {
      await fixture.restore();
    }
  });

  test("a usage limit with a stated time is waited for exactly that long, plus the margin", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      if (starts === 1) return await submitThenFail(turn, chatGptUsageLimitError(2 * 60_000));
      return await succeed(turn);
    });
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const events: AdapterEvent[] = [];
    try {
      const run = createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      await flush();
      mock.timers.tick(2 * 60_000 + RETRY_AFTER_MARGIN_MS - 1_000);
      await flush();
      expect(starts).toBe(1);
      mock.timers.tick(1_001);
      await flush();
      await run;
      expect(starts).toBe(2);
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally {
      await fixture.restore();
    }
  });

  test("a reconnect of the same native turn cannot skip the wait or cause a second submission", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      if (starts === 1) return await submitThenFail(turn, chatGptModelAtCapacityError());
      return await succeed(turn);
    });
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const first: AdapterEvent[] = [];
    const second: AdapterEvent[] = [];
    try {
      const adapter = createChatGptWebAdapter(fixture.provider);
      const firstRun = adapter.runTurn!(request, { headers: new Headers() }, event => first.push(event));
      await flush();
      expect(starts).toBe(1);
      // The client reconnects (same turn, same canonical request) while the wait is running.
      const secondRun = adapter.runTurn!(request, { headers: new Headers() }, event => second.push(event));
      await flush();
      mock.timers.tick(10_000);
      await flush();
      expect(starts).toBe(1);
      mock.timers.tick(20_001);
      await flush();
      await Promise.all([firstRun, secondRun]);
      expect(starts).toBe(2);
      expect(first.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(second.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally {
      await fixture.restore();
    }
  });

  test("the wait ends the moment the client goes away, and nothing is submitted afterwards", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      return await submitThenFail(turn, chatGptModelAtCapacityError());
    });
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const controller = new AbortController();
    try {
      const run = createChatGptWebAdapter(fixture.provider).runTurn!(
        request, { headers: new Headers(), abortSignal: controller.signal }, () => {},
      );
      const settled = run.then(() => "resolved" as const, error => (error as Error).name);
      await flush();
      expect(starts).toBe(1);
      controller.abort();
      await flush();
      expect(await settled).toBe("AbortError");
      mock.timers.tick(10 * 60_000);
      await flush();
      expect(starts).toBe(1);
    } finally {
      await fixture.restore();
    }
  });

  test("when the budget is used up the failure is reported once, explained, not retryable, and replayed without another submission", async () => {
    const fixture = setup({ limitWaitBudgetMs: 60_000 });
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      return await submitThenFail(turn, chatGptModelAtCapacityError());
    });
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const events: AdapterEvent[] = [];
    try {
      const adapter = createChatGptWebAdapter(fixture.provider);
      const run = adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
      await flush();
      mock.timers.tick(30_001);
      await flush();
      expect(starts).toBe(2);
      mock.timers.tick(30_001);
      await flush();
      await run;
      expect(starts).toBe(3);
      expect(events.at(-1)).toMatchObject({
        type: "error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, status: 503, retryable: false,
      });
      expect((events.at(-1) as { message: string }).message).toContain("wait budget");
      expect(contentEvents(events).filter(event => event.type === "error")).toHaveLength(1);

      // Codex asking again for the same turn gets the same answer without touching the browser.
      const again: AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => again.push(event));
      expect(again.at(-1)).toMatchObject({ type: "error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: false });
      expect(starts).toBe(3);
    } finally {
      await fixture.restore();
    }
  });

  test("a usage limit that clears later than the budget allows is reported at once, with its time", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      return await submitThenFail(turn, chatGptUsageLimitError(5 * 60 * 60_000));
    });
    try {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(starts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "error", code: CHATGPT_USAGE_LIMIT_CODE, status: 429, retryable: false });
      const message = (events.at(-1) as { message: string }).message;
      expect(message).toContain("Try again in 5 hours");
      expect(message).toContain("longer than the 2 hours");
    } finally {
      await fixture.restore();
    }
  });

  test("a budget of 0 turns the wait off: the failure is reported at once and keeps the normal retry class", async () => {
    const fixture = setup({ limitWaitBudgetMs: 0 });
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      return await submitThenFail(turn, chatGptModelAtCapacityError());
    });
    try {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(starts).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, status: 503, retryable: true,
      });
    } finally {
      await fixture.restore();
    }
  });

  test("the environment variable can turn the wait off for a bridge that a supervisor started", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      return await submitThenFail(turn, chatGptModelAtCapacityError());
    });
    process.env[LIMIT_WAIT_MINUTES_ENV] = "0";
    try {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(starts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: true });
    } finally {
      delete process.env[LIMIT_WAIT_MINUTES_ENV];
      await fixture.restore();
    }
  });

  test("nothing is retried once output has already reached the client's stream", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      await turn.onSendActivated?.();
      await turn.onSubmitted?.();
      turn.onTextDelta("The first half of an answer");
      await Bun.sleep(60);
      throw chatGptModelAtCapacityError();
    });
    try {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(starts).toBe(1);
      expect(events.some(event => event.type === "text_delta" && event.text.includes("first half"))).toBeTrue();
      // Rebuilding the turn inside the same stream would duplicate that text, so the failure goes to
      // Codex like any other ChatGPT response error that may be retried in a new stream.
      expect(events.at(-1)).toMatchObject({ type: "error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: true });
    } finally {
      await fixture.restore();
    }
  });

  test("other failures keep their existing behavior: they are neither held nor waited for", async () => {
    const fixture = setup();
    const request = turnRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      return await submitThenFail(turn, new ChatGptWebAdapterError("ChatGPT displayed an error for this response.", {
        status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
      }));
    });
    try {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(starts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "error", code: "upstream_server_error", retryable: true });
    } finally {
      await fixture.restore();
    }
  });
});

describe("compaction", () => {
  function compactionRequest(id: string): CodexParsedRequest {
    const turnId = `turn_compact_${id}`;
    return {
      modelId: "gpt-5.6-sol",
      stream: true,
      context: {
        messages: [
          { role: "user", content: "Original task", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
          { role: "user", content: "Continue with the next step", timestamp: 3 },
        ],
      },
      options: { reasoning: "high" },
      _compactionRequest: true,
      _rawBody: {
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue with the next step" }],
          internal_chat_message_metadata_passthrough: { turn_id: `turn_source_${id}` },
        }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_compact_${id}`, turn_id: turnId }) },
      },
    };
  }

  test("a summary chat refused for capacity is waited out, then the compaction is rebuilt in a fresh chat", async () => {
    const launcherRoot = join(root, `launcher-${sequence}`);
    mkdirSync(launcherRoot, { recursive: true });
    const fixture = setup({ browserHost: "launcher", browserHostDescriptorPath: join(launcherRoot, "launcher.json") }, true);
    const request = compactionRequest(fixture.id);
    let starts = 0;
    const prompts: string[] = [];
    fixture.setRun(async turn => {
      starts += 1;
      prompts.push((await turn.prepare()).text);
      await turn.onSubmitted?.();
      if (starts === 1) throw chatGptModelAtCapacityError();
      turn.onTextDelta("Checkpoint written after the model recovered");
      return "Checkpoint written after the model recovered";
    });
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const events: AdapterEvent[] = [];
    try {
      const run = createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      await flush();
      expect(starts).toBe(1);
      expect(events.some(event => event.type === "error")).toBeFalse();
      mock.timers.tick(30_001);
      await flush();
      await run;
      expect(starts).toBe(2);
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(events.some(event => event.type === "text_delta"
        && event.text.includes("Checkpoint written after the model recovered"))).toBeTrue();
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      // Both attempts summarize the same complete canonical history.
      expect(prompts[1]).toBe(prompts[0]!);
    } finally {
      await fixture.restore();
    }
  });

  test("a compaction refused by a usage limit that clears beyond the budget is reported at once, explained and not retryable", async () => {
    const launcherRoot = join(root, `launcher-${sequence}`);
    mkdirSync(launcherRoot, { recursive: true });
    const fixture = setup({
      browserHost: "launcher", browserHostDescriptorPath: join(launcherRoot, "launcher.json"), limitWaitBudgetMs: 30_000,
    }, true);
    const request = compactionRequest(fixture.id);
    let starts = 0;
    fixture.setRun(async turn => {
      starts += 1;
      await turn.onSubmitted?.();
      throw chatGptUsageLimitError(3 * 60 * 60_000);
    });
    try {
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(fixture.provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      // ChatGPT says three hours; this budget allows thirty seconds, so waiting cannot help.
      expect(starts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "error", code: CHATGPT_USAGE_LIMIT_CODE, status: 429, retryable: false });
      expect((events.at(-1) as { message: string }).message).toContain("Try again in 3 hours");
    } finally {
      await fixture.restore();
    }
  });
});

describe("a delivered tool round counts as progress", () => {
  test("it clears the failures that were charged to the native turn", async () => {
    const fixture = setup({}, true);
    const environmentXml = `<environment_context>\n  <cwd>${root}</cwd>\n  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
    const request = turnRequest(fixture.id);
    const raw = request._rawBody as { input: Array<Record<string, unknown>> };
    raw.input.unshift({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: environmentXml }],
      internal_chat_message_metadata_passthrough: { turn_id: `turn_${fixture.id}` },
    });
    request.context.tools = [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }];
    const retryKey = `${chatGptWebExecutionNamespace(fixture.provider)}:${chatGptTurnRetryKey(request)}`;
    const failure = new ChatGptWebAdapterError("ChatGPT is temporarily unavailable.", {
      status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
    });
    // Three earlier failures: one more would exhaust this native turn.
    for (let i = 0; i < 3; i += 1) chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, failure);
    expect(chatGptWebTurnRetryPolicy.exhaustedError(retryKey)).toBeUndefined();

    let markDelivered!: () => void;
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    fixture.setRun(async turn => {
      const prepared = await turn.prepare();
      try {
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("turn token missing from compiled prompt");
        await turn.onSubmitted?.();
        const claimed = await callTurnBroker<{ bindingId: string }>(fixture.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token });
        const progress = turn.externalProgress!;
        const previous = progress.snapshot().lastToolBatchRevision;
        const invocation = callTurnBroker<BrokerToolResult>(fixture.provider.chatgptWeb!.brokerSocketPath!, {
          method: "invoke", bindingId: claimed.bindingId, wireName: "exec_command", freeform: false,
          arguments: { cmd: "echo progress" },
        }, 30_000);
        let snapshot = progress.snapshot();
        while (snapshot.lastToolBatchRevision <= previous) snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
        await invocation;
        markDelivered();
        // The tool result is in; ChatGPT keeps working and never finishes in this test.
        return await new Promise<string>((_resolve, reject) => {
          const abort = () => reject(turn.abortSignal?.reason ?? new DOMException("aborted", "AbortError"));
          if (turn.abortSignal?.aborted) abort();
          else turn.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      } finally {
        prepared.release();
      }
    });

    const adapter = createChatGptWebAdapter(fixture.provider);
    try {
      const first: AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => first.push(event));
      const call = first.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
      expect(call?.name).toBe("exec_command");

      const continuation = structuredClone(request);
      continuation.context.messages.push(
        { role: "assistant", content: [{ type: "toolCall", id: call!.id, name: "exec_command", arguments: { cmd: "echo progress" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: call!.id, toolName: "exec_command", content: JSON.stringify({ output: "progress", exit_code: 0 }), isError: false, timestamp: 3 },
      );
      (continuation._rawBody as { input: unknown[] }).input.push(
        { type: "function_call", call_id: call!.id, name: "exec_command", arguments: JSON.stringify({ cmd: "echo progress" }) },
        { type: "function_call_output", call_id: call!.id, output: JSON.stringify({ output: "progress", exit_code: 0 }) },
      );
      const controller = new AbortController();
      const second = adapter.runTurn!(continuation, { headers: new Headers(), abortSignal: controller.signal }, () => {});
      const outcome = second.then(() => undefined, error => error);
      // The worker sees the result's reply only after the adapter has handed the result to ChatGPT.
      await delivered;
      await Bun.sleep(20);
      // After the reset a failure is the first of a fresh budget (retryable), not the fourth (exhausted).
      expect(chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, failure).retryable).toBeTrue();
      controller.abort();
      await outcome;
    } finally {
      chatGptWebTurnRetryPolicy.clear(retryKey);
      await fixture.restore();
    }
  }, 15_000);
});
