import { BrowserWindow, Notification, ipcMain } from "electron";
import type { AttentionNotificationTarget } from "@runweave/shared/attention";

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isTarget(value: unknown): value is AttentionNotificationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return ["connectionId", "attentionId", "parentProjectId", "projectId", "terminalSessionId"].every((key) => isId(target[key])) &&
    (target.panelId === null || isId(target.panelId)) &&
    typeof target.title === "string" && target.title.length > 0 && target.title.length <= 200 &&
    typeof target.body === "string" && target.body.length <= 300;
}

export function registerAttentionNotificationHandlers(getMainWindow: () => BrowserWindow | null): void {
  const shown = new Set<string>();
  ipcMain.handle("attention:notify", (event, value: unknown): boolean => {
    const window = getMainWindow();
    if (!window || window.webContents.id !== event.sender.id) throw new Error("Main window sender required");
    if (!isTarget(value)) throw new Error("Invalid Attention notification");
    if (window.isVisible() && window.isFocused()) return false;
    const key = `${value.connectionId}\n${value.attentionId}`;
    if (shown.has(key)) return false;
    shown.add(key);
    if (shown.size > 500) shown.delete(shown.values().next().value!);
    const notification = new Notification({ title: value.title, body: value.body, silent: true });
    notification.on("click", () => {
      window.show();
      window.focus();
      window.webContents.send("attention:notification-open", value);
    });
    notification.show();
    return true;
  });
  ipcMain.handle("scheduled-run:notify", (event, value: unknown): boolean => {
    const window = getMainWindow();
    if (!window || window.webContents.id !== event.sender.id) throw new Error("Main window sender required");
    if (!value || typeof value !== "object") throw new Error("Invalid scheduled run notification");
    const target = value as Record<string, unknown>;
    if (!isId(target.connectionId) || !isId(target.runId) ||
      typeof target.title !== "string" || !target.title.trim() || target.title.length > 120 ||
      typeof target.body !== "string" || target.body.length > 240) {
      throw new Error("Invalid scheduled run notification");
    }
    if (window.isVisible() && window.isFocused()) return false;
    const key = `scheduled-run:${target.connectionId}:${target.runId}`;
    if (shown.has(key)) return false;
    shown.add(key);
    if (shown.size > 500) shown.delete(shown.values().next().value!);
    const notification = new Notification({ title: target.title, body: target.body, silent: true });
    notification.on("click", () => {
      window.show(); window.focus();
      window.webContents.send("scheduled-run:notification-open", {
        connectionId: target.connectionId, runId: target.runId,
      });
    });
    notification.show();
    return true;
  });
}
