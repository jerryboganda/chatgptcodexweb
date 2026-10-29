import "./live-status.css";
import { liveAgeText, liveItemLabel, liveItemText, liveCopyFor } from "./live-copy";
import type { Language, LiveStatusSnapshot } from "./types";

// Sidebar panel: one row per probe, a dot that matches what the probe saw a moment ago, and the
// age of that reading. A reading that stops updating is shown as stale, never as current.
export function LiveStatusPanel({
  status,
  ageMs,
  stale,
  language,
  now,
}: {
  status: LiveStatusSnapshot | null;
  ageMs: number | null;
  stale: boolean;
  language: Language;
  now: number;
}) {
  const copy = liveCopyFor(language);
  return (
    <section className="live-status" aria-label={copy.title} aria-live="off" data-stale={stale ? "true" : "false"}>
      <header className="live-status-header">
        <span className="live-status-title">{copy.title}</span>
        <span className="live-status-age">{liveAgeText(ageMs, stale, copy)}</span>
      </header>
      <ul className="live-status-list">
        {(status?.items ?? []).map((item) => (
          <li className="live-status-row" key={item.id} data-tone={stale ? "off" : item.tone}>
            <span aria-hidden="true" className="live-status-dot" />
            <span className="live-status-name">{liveItemLabel(item, copy)}</span>
            <span className="live-status-text">{liveItemText(item, copy, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
