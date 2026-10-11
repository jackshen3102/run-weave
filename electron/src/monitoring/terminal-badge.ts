import { app, ipcMain, net, type BrowserWindow } from "electron";
import type { TerminalBadgeConnection } from "@runweave/shared/terminal-unread";
import { TerminalBadgeClient } from "./terminal-badge-client";

export function registerTerminalBadge(getWindow: () => BrowserWindow | null): () => void {
  const client = new TerminalBadgeClient(
    (url, init) => net.fetch(url, init),
    (count) => app.dock?.setBadge(count ? String(count) : ""),
  );
  const requireMainWindow = (senderId: number) => {
    if (getWindow()?.webContents.id !== senderId) throw new Error("Main window sender required");
  };
  ipcMain.handle("terminal:badge-connections", (event, input: unknown) => {
    requireMainWindow(event.sender.id);
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
    if (new Set(values.map((c) => c.id)).size !== values.length) throw new Error("Duplicate badge connections");
    client.setConnections(values);
  });
  ipcMain.handle("terminal:badge-status", (event) => {
    requireMainWindow(event.sender.id);
    return client.getStatus();
  });
  return () => {
    client.dispose();
    ipcMain.removeHandler("terminal:badge-connections");
    ipcMain.removeHandler("terminal:badge-status");
  };
}
