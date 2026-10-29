import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  classifyChatGptLimitNotices,
  throwIfChatGptLimitNotice,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptTerminalErrorAlert,
} from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptLimitNoticeTexts } from "../src/adapters/chatgpt-web/browser-limit-notice";
import { CHATGPT_MODEL_AT_CAPACITY_CODE, CHATGPT_USAGE_LIMIT_CODE } from "../src/adapters/chatgpt-web/limit-wait";

type Scope = Parameters<typeof throwIfChatGptTerminalErrorAlert>[0];

const CAPACITY = "Selected model is at capacity. Please try a different model.";
const GENERIC = "Something went wrong. If this issue persists please contact us through our help center at help.openai.com.";

function responseScope(options: {
  retryControl?: boolean;
  somethingWentWrong?: boolean;
  notices?: string[] | Error | "unreadable";
}): { scope: Scope; reads: unknown[][] } {
  const reads: unknown[][] = [];
  const scope = {
    getByTestId: (id: string) => ({
      last: () => ({ isVisible: async () => options.retryControl === true && id === "regenerate-thread-error-button" }),
    }),
    getByText: () => ({ last: () => ({ isVisible: async () => options.somethingWentWrong === true }) }),
    ...(options.notices === "unreadable" ? {} : {
      evaluate: async (...args: unknown[]) => {
        reads.push(args);
        if (options.notices instanceof Error) throw options.notices;
        return options.notices ?? [];
      },
    }),
  } as unknown as Scope;
  return { scope, reads };
}

describe("a response that ended in ChatGPT's own error surface", () => {
  test("a model at capacity is its own failure, found from the notice text, not the generic one", async () => {
    const { scope, reads } = responseScope({ retryControl: true, notices: [CAPACITY] });
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({
      name: "ChatGptWebAdapterError", status: 503, errorType: "server_error", code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: false,
    });
    // The page-side reader gets the real extraction function and a bounded timeout.
    expect(reads[0]![0]).toBe(chatGptLimitNoticeTexts);
    expect(reads[0]![2]).toEqual({ timeout: 2_000 });
  });

  test("a usage limit carries the time ChatGPT stated", async () => {
    const { scope } = responseScope({ somethingWentWrong: true, notices: ["You've reached your usage limit. Try again in 3 hours."] });
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({
      status: 429, errorType: "rate_limit_error", code: CHATGPT_USAGE_LIMIT_CODE, retryable: false,
      message: expect.stringContaining("Try again in 3 hours"),
    });
  });

  test.each([
    ["an ordinary error notice", { retryControl: true, notices: [GENERIC] }],
    ["no readable notice", { retryControl: true, notices: [] }],
    ["a notice that cannot be read", { retryControl: true, notices: new Error("evaluate timed out") }],
    ["a reader that does not exist", { retryControl: true, notices: "unreadable" as const }],
  ])("keeps the generic retryable failure for %s", async (_name, options) => {
    const { scope } = responseScope(options);
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({
      status: 502, code: "upstream_server_error", retryable: true,
    });
  });

  test("the 'Something went wrong' alert alone is still the generic failure", async () => {
    const { scope } = responseScope({ somethingWentWrong: true, notices: [GENERIC] });
    await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({ code: "upstream_server_error", retryable: true });
  });

  test("without an error surface nothing is read and nothing is thrown, whatever else the page says", async () => {
    const { scope, reads } = responseScope({ notices: [CAPACITY] });
    await expect(throwIfChatGptTerminalErrorAlert(scope)).resolves.toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  test("only product notices are classified, in order", () => {
    expect(classifyChatGptLimitNotices(["Copied to clipboard", CAPACITY])).toMatchObject({ code: CHATGPT_MODEL_AT_CAPACITY_CODE });
    expect(classifyChatGptLimitNotices(["Copied to clipboard", GENERIC])).toBeUndefined();
    expect(classifyChatGptLimitNotices([])).toBeUndefined();
  });
});

function noticePage(notices: string[] | Error | "missing"): { page: Page; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const page = notices === "missing" ? {} : {
    locator: (selector: string) => ({
      evaluate: async (...args: unknown[]) => {
        calls.push([selector, ...args]);
        if (notices instanceof Error) throw notices;
        return notices;
      },
    }),
  };
  return { page: page as unknown as Page, calls };
}

describe("a notice outside the response turn", () => {
  test("a model at capacity or a usage limit shown above the composer fails the turn", async () => {
    const capacity = noticePage([CAPACITY]);
    await expect(throwIfChatGptLimitNotice(capacity.page, 10_000)).rejects.toMatchObject({ code: CHATGPT_MODEL_AT_CAPACITY_CODE });
    expect(capacity.calls[0]![0]).toBe("html");
    expect(capacity.calls[0]![1]).toBe(chatGptLimitNoticeTexts);
    await expect(throwIfChatGptLimitNotice(noticePage(["Usage limit reached. Try again in 45 minutes."]).page, 10_000))
      .rejects.toMatchObject({ code: CHATGPT_USAGE_LIMIT_CODE, message: expect.stringContaining("Try again in 45 minutes") });
  });

  test("ordinary notices, unreadable pages and pages without the API are left to the other observers", async () => {
    await expect(throwIfChatGptLimitNotice(noticePage([GENERIC, "Message copied"]).page, 10_000)).resolves.toBeUndefined();
    await expect(throwIfChatGptLimitNotice(noticePage(new Error("Target closed")).page, 10_000)).resolves.toBeUndefined();
    await expect(throwIfChatGptLimitNotice(noticePage("missing").page, 10_000)).resolves.toBeUndefined();
  });

  test("the probe is throttled per page so a fast observation loop costs one read a second", async () => {
    const fixture = noticePage([]);
    for (const now of [1_000, 1_300, 1_999]) await throwIfChatGptLimitNotice(fixture.page, now);
    expect(fixture.calls).toHaveLength(1);
    await throwIfChatGptLimitNotice(fixture.page, 2_001);
    expect(fixture.calls).toHaveLength(2);
    // Another page is independent.
    const other = noticePage([]);
    await throwIfChatGptLimitNotice(other.page, 2_002);
    expect(other.calls).toHaveLength(1);
  });
});

function dialogPage(text: string, innerTextFails = false): Page {
  const make = () => {
    let visible = true;
    const chain = {
      filter: ({ hasText }: { hasText: string | RegExp }) => {
        visible &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
        return chain;
      },
      last: () => chain,
      isVisible: async () => visible,
      innerText: async () => {
        if (innerTextFails) throw new Error("detached");
        return text;
      },
      getByRole: () => ({ last: () => ({ isVisible: async () => false, press: async () => {} }) }),
    };
    return chain;
  };
  return { locator: () => make() } as unknown as Page;
}

describe("a limit dialog", () => {
  test("a usage-limit dialog is classified with its stated time", async () => {
    await expect(throwIfChatGptRateLimitDialog(dialogPage("You've reached your usage limit. Try again in 2 hours 5 minutes.")))
      .rejects.toMatchObject({
        code: CHATGPT_USAGE_LIMIT_CODE, status: 429, retryable: false,
        message: expect.stringContaining("Try again in 2 hours 5 minutes"),
      });
  });

  test("a capacity dialog is classified", async () => {
    await expect(throwIfChatGptRateLimitDialog(dialogPage(CAPACITY)))
      .rejects.toMatchObject({ code: CHATGPT_MODEL_AT_CAPACITY_CODE, status: 503 });
  });

  test("the burst-throttle dialog is still its own hard stop, not a wait", async () => {
    await expect(throwIfChatGptRateLimitDialog(dialogPage("Too many requests. You're making requests too quickly.")))
      .rejects.toMatchObject({ code: "rate_limit_exceeded", status: 429, retryable: false });
  });

  test.each([
    "Confirm another action",
    "Upgrade to Plus for higher usage limits.",
    "You have 3 messages left before you hit the limit.",
  ])("unrelated or merely informational dialogs are left alone: %s", async text => {
    await expect(throwIfChatGptRateLimitDialog(dialogPage(text))).resolves.toBeUndefined();
  });

  test("a dialog whose text cannot be read changes nothing", async () => {
    await expect(throwIfChatGptRateLimitDialog(dialogPage("You've reached your usage limit.", true))).resolves.toBeUndefined();
  });
});

describe("the page-side notice reader", () => {
  test("is self-contained, because Playwright serializes it into the page", () => {
    const source = chatGptLimitNoticeTexts.toString();
    expect(source).not.toContain("import(");
    expect(source).toContain("regenerate-thread-error-button");
    // Assistant Markdown, the user's message and code are never read.
    expect(source).toContain(".markdown");
    expect(source).toContain("data-user-message-bubble");
  });
});

const DOM_BROWSER = process.env.CHATGPT_DOM_TEST_BROWSER;

/** The probes bound each page read to two seconds; a heavily loaded CI machine can miss that once. */
async function eventually(assertion: () => Promise<void>, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}

test.skipIf(!DOM_BROWSER)("in a real DOM only ChatGPT's own error notices are read", async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: DOM_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section id="turn">
        <div data-message-author-role="user"><div role="alert">user quoted: usage limit reached</div></div>
        <div class="markdown"><p>This service is at capacity</p><div role="alert">alert quoted in an answer: at capacity</div></div>
        <div role="alert" style="display:none">hidden: model is at capacity</div>
        <pre><code role="alert">code: at capacity</code></pre>
      </section>`);
    const turn = page.locator("#turn");
    const read = (scope: ReturnType<typeof page.locator>) => scope.evaluate(chatGptLimitNoticeTexts, undefined, { timeout: 30_000 });
    expect(await read(page.locator("html"))).toEqual([]);
    let probeTime = 100_000;
    await expect(throwIfChatGptLimitNotice(page, (probeTime += 10_000))).resolves.toBeUndefined();

    await page.evaluate(() => {
      document.querySelector("#turn")!.insertAdjacentHTML("beforeend", `
        <div id="explained"><div>Selected model is at capacity. Please try a different model.</div>
        <button data-testid="regenerate-thread-error-button">Retry</button></div>`);
    });
    await eventually(async () => { await expect(throwIfChatGptTerminalErrorAlert(turn)).rejects.toMatchObject({
      code: CHATGPT_MODEL_AT_CAPACITY_CODE, retryable: false,
    }); });
    expect(await read(turn)).toEqual([expect.stringContaining("at capacity")]);

    // A Retry control that sits in the same container as response Markdown is never read for text.
    await page.evaluate(() => {
      document.querySelector("#explained")!.remove();
      document.querySelector("#turn")!.insertAdjacentHTML("beforeend", `
        <div><div class="markdown">The model is at capacity, the answer explains.</div>
        <button data-testid="regenerate-thread-error-button">Retry</button></div>`);
    });
    expect(await read(turn)).toEqual([]);
    await expect(throwIfChatGptTerminalErrorAlert(turn)).rejects.toMatchObject({ code: "upstream_server_error", retryable: true });

    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `<div role="alert">You've reached your usage limit. Try again in 2 hours.</div>`);
    });
    await eventually(async () => { await expect(throwIfChatGptLimitNotice(page, (probeTime += 10_000))).rejects.toMatchObject({
      code: CHATGPT_USAGE_LIMIT_CODE, message: expect.stringContaining("Try again in 2 hours"),
    }); });
  } finally { await browser.close(); }
}, 90_000);
