import { app, ipcMain, net, type BrowserWindow } from "electron";
import type { TerminalBadgeConnection, TerminalUnreadSnapshot } from "@runweave/shared/terminal-unread";

export function registerTerminalBadge(getWindow: () => BrowserWindow | null): () => void {
  const connections = new Map<string, TerminalBadgeConnection>();
  const snapshots = new Map<string, TerminalUnreadSnapshot>();
  let stopped = false;
  let flight: Promise<void> | null = null;
  const controller = new AbortController();
  const render = () => {
    const hosts = new Map<string, TerminalUnreadSnapshot>();
    for (const snapshot of snapshots.values()) {
      if ((hosts.get(snapshot.hostId)?.revision ?? -1) < snapshot.revision) hosts.set(snapshot.hostId, snapshot);
    }
    const count = [...hosts.values()].reduce((sum, value) => sum + value.count, 0);
    app.dock?.setBadge(count ? String(count) : "");
  };
  const poll = () => {
    if (stopped || flight) return;
    flight = Promise.allSettled([...connections.values()].map(async (connection) => {
      if (!connection.token || !connection.url) return;
      try {
        const response = await net.fetch(`${connection.url}/api/terminal/unread`, {
          headers: { Authorization: `Bearer ${connection.token}` },
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) return;
        const value = await response.json() as TerminalUnreadSnapshot;
        if (stopped || connections.get(connection.id) !== connection ||
            typeof value.hostId !== "string" || !value.hostId ||
            !Number.isSafeInteger(value.count) || value.count < 0 ||
            !Number.isSafeInteger(value.revision) || value.revision < 1) return;
        const previous = snapshots.get(connection.id);
        if (previous?.hostId === value.hostId && previous.revision > value.revision) return;
        snapshots.set(connection.id, value);
        render();
      } catch { /* Offline is not zero; retain the last successful snapshot. */ }
    })).then(() => undefined).finally(() => { flight = null; });
  };
  ipcMain.handle("terminal:badge-connections", (event, input: unknown) => {
    if (getWindow()?.webContents.id !== event.sender.id) throw new Error("Main window sender required");
    if (!Array.isArray(input) || input.length > 100) throw new Error("Invalid badge connections");
    const values = input.map((value: unknown): TerminalBadgeConnection => {
      if (!value || typeof value !== "object") throw new Error("Invalid badge connection");
      const c = value as TerminalBadgeConnection;
      if (typeof c.id !== "string" || !c.id || c.id.length > 512 || typeof c.url !== "string" ||
          !(c.token === null || typeof c.token === "string" && c.token.length < 16384)) throw new Error("Invalid badge connection");
      if (c.url) {
        const url = new URL(c.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Backend URL");
      }
      return { id: c.id, url: c.url.replace(/\/+$/, ""), token: c.token };
    });
    const ids = new Set(values.map((c) => c.id));
    for (const id of connections.keys()) if (!ids.has(id)) { connections.delete(id); snapshots.delete(id); }
    for (const value of values) {
      const old = connections.get(value.id);
      if (!value.token) snapshots.delete(value.id);
      if (!old || old.token !== value.token || old.url !== value.url) connections.set(value.id, value);
    }
    render();
    poll();
  });
  const timer = setInterval(poll, 2_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); controller.abort(); connections.clear(); snapshots.clear(); };
}
