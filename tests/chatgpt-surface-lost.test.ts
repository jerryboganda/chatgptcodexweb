import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_SURFACE_LOST_CODE,
  ChatGptBrowserPageClosedError,
  ChatGptWebAdapterError,
  chatGptBrowserPageClosedError,
  chatGptBrowserSurfaceLostError,
  chatGptBrowserTabClosedError,
  chatGptTurnSupersededError,
  isChatGptClosedBrowserTargetError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, isChatGptLostSurfaceError } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(controlEndpoint: string): string {
  const root = mkdtempSync(join(tmpdir(), "codex-surface-lost-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: { endpoint: controlEndpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

/** A launcher whose end-of-turn handshake says what the test wants it to say. */
function fakeLauncher(end: () => Response | Promise<Response>) {
  const phases: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const activity = await request.json() as { phase: string; status?: string };
      phases.push(activity.phase === "end" ? `end:${activity.status}` : activity.phase);
      if (activity.phase === "start") return Response.json({ surfaceId: "a".repeat(32), reused: false, connectorBound: false });
      if (activity.phase === "end") return await end();
      return Response.json({});
    },
  });
  return { server, phases, descriptor: descriptorFile(`http://127.0.0.1:${server.port}`) };
}

function workerFailing(descriptor: string, failure: () => unknown) {
  return Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptor },
    runBrowserTurn: async () => { throw failure(); },
  }) as { runExclusive(turn: unknown): Promise<string> };
}

const turn = (extra: Record<string, unknown> = {}) => ({ traceId: "surface-lost", capabilities: { localToolsEnabled: false }, ...extra });

describe("a launcher surface that vanished without a user closing it", () => {
  test("is retryable into a new chat, and says so", async () => {
    const launcher = fakeLauncher(() => Response.json({ cancelledByUser: false }));
    try {
      const worker = workerFailing(launcher.descriptor, chatGptBrowserPageClosedError);
      await expect(worker.runExclusive(turn())).rejects.toMatchObject({
        name: "ChatGptWebAdapterError",
        status: 503,
        errorType: "server_error",
        code: CHATGPT_SURFACE_LOST_CODE,
        retryable: true,
        message: expect.stringContaining("complete task history"),
      });
      expect(launcher.phases.at(-1)?.startsWith("end:")).toBeTrue();
    } finally { launcher.server.stop(true); }
  });

  test("a closed browser target reported by Playwright is the same lost surface", async () => {
    const launcher = fakeLauncher(() => Response.json({ cancelledByUser: false }));
    try {
      for (const message of [
        "page.evaluate: Target page, context or browser has been closed",
        "locator.isVisible: Target closed",
        "Page crashed",
        "browserContext.newPage: Browser has been closed",
      ]) {
        const worker = workerFailing(launcher.descriptor, () => new Error(message));
        await expect(worker.runExclusive(turn())).rejects.toMatchObject({ code: CHATGPT_SURFACE_LOST_CODE, retryable: true });
      }
    } finally { launcher.server.stop(true); }
  });

  test("keeps the original failure as its cause", async () => {
    const launcher = fakeLauncher(() => Response.json({ cancelledByUser: false }));
    try {
      const worker = workerFailing(launcher.descriptor, () => new Error("Target crashed"));
      const error = await worker.runExclusive(turn()).then(() => undefined, (caught: ChatGptWebAdapterError) => caught);
      expect((error!.cause as Error).message).toBe("Target crashed");
    } finally { launcher.server.stop(true); }
  });
});

describe("a tab that a user closed stays a terminal cancellation", () => {
  test("the launcher's own record of the user's close wins", async () => {
    const launcher = fakeLauncher(() => Response.json({ cancelledByUser: true }));
    try {
      for (const failure of [chatGptBrowserPageClosedError, () => new Error("Target page, context or browser has been closed")]) {
        const worker = workerFailing(launcher.descriptor, failure);
        await expect(worker.runExclusive(turn())).rejects.toMatchObject({
          code: "client_cancelled", status: 499, retryable: false,
        });
      }
    } finally { launcher.server.stop(true); }
  });

  test("so does a stop that the runtime itself asked for", async () => {
    const launcher = fakeLauncher(() => Response.json({ cancelledByUser: false }));
    try {
      const aborted = new AbortController();
      // The runtime cancels the turn while the helper is running, and the page goes away with it.
      const worker = workerFailing(launcher.descriptor, () => {
        aborted.abort(chatGptBrowserTabClosedError());
        return new Error("Target closed");
      });
      const error = await worker.runExclusive(turn({ abortSignal: aborted.signal })).catch(caught => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Target closed");
      expect(error).not.toBeInstanceOf(ChatGptWebAdapterError);
    } finally { launcher.server.stop(true); }
  });
});

describe("it is never guessed", () => {
  test("without a successful end-of-turn handshake the closed tab stays terminal", async () => {
    const launcher = fakeLauncher(() => new Response("boom", { status: 500 }));
    try {
      const worker = workerFailing(launcher.descriptor, chatGptBrowserPageClosedError);
      await expect(worker.runExclusive(turn())).rejects.toMatchObject({ code: "client_cancelled", retryable: false });
    } finally { launcher.server.stop(true); }
  });

  test("only the worker's own page-closed observation converts; other cancellations and errors do not", async () => {
    const launcher = fakeLauncher(() => Response.json({ cancelledByUser: false }));
    try {
      for (const [failure, code] of [
        [chatGptBrowserTabClosedError, "client_cancelled"],
        [chatGptTurnSupersededError, "client_cancelled"],
        [() => new ChatGptWebAdapterError("ChatGPT rate limit", { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false }), "rate_limit_exceeded"],
      ] as const) {
        const worker = workerFailing(launcher.descriptor, failure);
        await expect(worker.runExclusive(turn())).rejects.toMatchObject({ code });
      }
      const unrelated = workerFailing(launcher.descriptor, () => new Error("ChatGPT send button remained disabled"));
      await expect(unrelated.runExclusive(turn())).rejects.toThrow("send button remained disabled");
    } finally { launcher.server.stop(true); }
  });

  test("the decision is a pure function of the evidence", () => {
    const closed = new ChatGptBrowserPageClosedError();
    expect(isChatGptLostSurfaceError(closed, false)).toBeTrue();
    expect(isChatGptLostSurfaceError(closed, true)).toBeFalse();
    expect(isChatGptLostSurfaceError(closed, false, AbortSignal.abort())).toBeFalse();
    expect(isChatGptLostSurfaceError(new Error("Target closed"), false)).toBeTrue();
    expect(isChatGptLostSurfaceError(new Error("Execution context was destroyed"), false)).toBeFalse();
    expect(isChatGptLostSurfaceError(chatGptBrowserTabClosedError(), false)).toBeFalse();
    expect(isChatGptLostSurfaceError(undefined, false)).toBeFalse();
    expect(isChatGptClosedBrowserTargetError(chatGptBrowserSurfaceLostError())).toBeFalse();
  });

  test("a page-closed marker is still the usual terminal error for everyone who only checks its code", () => {
    const closed = chatGptBrowserPageClosedError();
    expect(closed).toMatchObject({ code: "client_cancelled", status: 499, retryable: false });
    expect(closed.message).toBe(chatGptBrowserTabClosedError().message);
  });

  test("every place the worker notices its own closed page uses the marker", () => {
    const source = readFileSync(join(import.meta.dir, "../src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
    expect(source).not.toMatch(/isClosed\(\)[^;{]*\)?\s*\{?\s*throw chatGptBrowserTabClosedError\(\)/);
    expect(source.match(/throw chatGptBrowserPageClosedError\(\)/g)?.length).toBeGreaterThanOrEqual(5);
    // A user-requested close is still reported through the launcher's own answer.
    expect(source).toMatch(/if \(release\.cancelledByUser\) throw chatGptBrowserTabClosedError\(\)/);
  });
});
