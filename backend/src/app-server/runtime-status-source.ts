import type { RuntimeStatusRegistry } from "../runtime-status/registry";
import type { AppServerClient } from "./client";

const POLL_INTERVAL_MS = 5_000;

export interface AppServerRuntimeStatusSourceHandle {
  stop(): Promise<void>;
}

export function startAppServerRuntimeStatusSource(
  client: AppServerClient,
  registry: RuntimeStatusRegistry,
): AppServerRuntimeStatusSourceHandle {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= (async () => {
      const report = await client.getRuntimeStatus(AbortSignal.timeout(1_000));
      if (!stopped && report?.source.runtime === "app-server") {
        registry.setExternalReport(report);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  void poll();
  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
