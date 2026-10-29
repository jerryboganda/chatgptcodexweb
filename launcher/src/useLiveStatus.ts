import { useEffect, useState } from "react";
import type { LauncherApi, LiveStatusSnapshot } from "./types";

type LiveApi = Pick<LauncherApi, "liveStatus" | "onLiveStatus">;

// The main process probes every 3 s. A reading older than this means the probes stopped, and the panel
// says so instead of leaving the last answer on screen as if it were current.
export const LIVE_STATUS_STALE_MS = 12_000;

export function useLiveStatus(api: LiveApi) {
  const [status, setStatus] = useState<LiveStatusSnapshot | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let cancelled = false;
    void api.liveStatus().then((next) => {
      if (!cancelled && next) setStatus(next);
    }).catch(() => {});
    const unsubscribe = api.onLiveStatus((next) => {
      if (!cancelled) setStatus(next);
    });
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [api]);

  const ageMs = status ? Math.max(0, now - status.checkedAt) : null;
  return { status, ageMs, now, stale: ageMs !== null && ageMs > LIVE_STATUS_STALE_MS };
}
