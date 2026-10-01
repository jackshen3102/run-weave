import { useEffect, useState } from "react";
import type { SystemMonitorSnapshot } from "@runweave/shared/system-monitor";
import { useResources } from "./resource-monitor-provider";
/** Pause affects presentation only. App-owned polling and Backend sampling continue. */
export function useSystemMonitor(paused: boolean) {
  const resource = useResources();
  const [snapshot, setSnapshot] = useState<SystemMonitorSnapshot | null>(null);
  useEffect(() => {
    if (!paused) setSnapshot(resource.data?.snapshot ?? null);
  }, [paused, resource.data]);
  return { snapshot, resource };
}
