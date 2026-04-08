import { useEffect, useState } from "react";
import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";

const POLL_INTERVAL_MS = 2_000;

export function useElectronRuntimeStats(): {
  snapshot: RuntimeStatsSnapshot | null;
  error: string | null;
} {
  const [snapshot, setSnapshot] = useState<RuntimeStatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getRuntimeStats = window.electronAPI?.getRuntimeStats;
    if (window.electronAPI?.isElectron !== true || !getRuntimeStats) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const poll = async (): Promise<void> => {
      try {
        const nextSnapshot = await getRuntimeStats();
        if (cancelled) {
          return;
        }
        setSnapshot(nextSnapshot);
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
          }, POLL_INTERVAL_MS);
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
  }, []);

  return { snapshot, error };
}
