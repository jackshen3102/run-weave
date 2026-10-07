import { useEffect } from "react";
import { getConnectionAuth } from "../auth/storage";
import type { ConnectionConfig } from "../connection/types";

/** Credentials follow the existing app-wide auth owners; counting runs in Electron main. */
export function useDesktopBadge(connections: ConnectionConfig[]): void {
  useEffect(() => {
    const bridge = window.electronAPI;
    if (!bridge?.setTerminalBadgeConnections) return;
    const publish = bridge.setTerminalBadgeConnections;
    let previous = "";
    const sync = () => {
      const values = connections.map((c) => ({
        id: c.id, url: c.url, token: getConnectionAuth(c.id)?.accessToken ?? null,
      }));
      const key = JSON.stringify(values);
      if (previous === key) return;
      previous = key;
      void publish(values).catch(() => { previous = ""; });
    };
    sync();
    const timer = window.setInterval(sync, 1_000);
    return () => window.clearInterval(timer);
  }, [connections]);
}
