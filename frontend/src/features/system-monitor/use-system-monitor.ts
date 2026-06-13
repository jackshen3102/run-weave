import { useEffect, useState } from "react";
import type { SystemMonitorSnapshot } from "@runweave/shared";

const MAX_FRAME_COUNT = 12;

export function useSystemMonitor(params: {
  intervalMs: number;
  paused: boolean;
}): {
  snapshot: SystemMonitorSnapshot | null;
  frames: SystemMonitorSnapshot[];
  error: string | null;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<SystemMonitorSnapshot | null>(null);
  const [frames, setFrames] = useState<SystemMonitorSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const getSystemMonitorSnapshot =
      window.electronAPI?.getSystemMonitorSnapshot;
    if (
      window.electronAPI?.isElectron !== true ||
      !getSystemMonitorSnapshot ||
      params.paused
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const poll = async (): Promise<void> => {
      try {
        const nextSnapshot = await getSystemMonitorSnapshot();
        if (cancelled) {
          return;
        }
        setSnapshot(nextSnapshot);
        setFrames((current) =>
          [nextSnapshot, ...current].slice(0, MAX_FRAME_COUNT),
        );
        setError(null);
      } catch (currentError) {
        if (cancelled) {
          return;
        }
        setError(String(currentError));
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void poll();
          }, params.intervalMs);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [params.intervalMs, params.paused, refreshToken]);

  return {
    snapshot,
    frames,
    error,
    refresh: () => setRefreshToken((current) => current + 1),
  };
}
