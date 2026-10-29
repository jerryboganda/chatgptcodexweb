/**
 * Runs in the page. Returns the text of ChatGPT's own visible error notices below `root` (the whole
 * document when omitted) so the worker can classify "model at capacity" and usage-limit messages.
 *
 * Only product notices are read: alerts, plus the explanation shown next to the response-error Retry
 * action. Assistant Markdown, the user's own message, code and the composer are never read, so an
 * answer that talks about capacity or limits can never be mistaken for a failure. The function must
 * stay self-contained: Playwright serializes it into the page.
 */
export function chatGptLimitNoticeTexts(root?: ParentNode): string[] {
  const scope: ParentNode = root ?? document;
  const excluded = '.markdown, [data-message-author-role="user"], [data-user-message-bubble], '
    + '[data-conversation-role="user"], [contenteditable="true"], textarea, pre, code';
  const visible = (element: Element): boolean => {
    const html = element as HTMLElement;
    return typeof html.checkVisibility === "function"
      ? html.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : true;
  };
  const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  const texts: string[] = [];
  const add = (text: string): void => {
    if (text && !texts.includes(text)) texts.push(text);
  };
  for (const alert of scope.querySelectorAll('[role="alert"], [role="alertdialog"]')) {
    if (alert.closest(excluded) || !visible(alert)) continue;
    add(clean((alert as HTMLElement).innerText));
  }
  // The response-error action is rendered beside its explanation, not inside an alert.
  for (const retry of scope.querySelectorAll('[data-testid="regenerate-thread-error-button"]')) {
    if (retry.closest(excluded) || !visible(retry)) continue;
    let container = retry.parentElement;
    for (let depth = 0; container && depth < 3; depth += 1, container = container.parentElement) {
      if (container.querySelector(".markdown")) break;
      const text = clean(container.innerText);
      if (text) {
        add(text);
        break;
      }
    }
  }
  return texts;
}
