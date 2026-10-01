import { BrowserWindow, Notification, ipcMain } from "electron";
import type { ResourceNotificationTarget } from "@runweave/shared/resource-monitor";
export function registerResourceNotificationHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
  const shown = new Set<string>();
  ipcMain.handle(
    "resource:notify",
    async (
      event,
      value: unknown,
    ): Promise<"submitted" | "skipped" | "unavailable" | "failed"> => {
      const window = getMainWindow();
      if (!window || window.webContents.id !== event.sender.id)
        throw new Error("Main window sender required");
      if (!value || typeof value !== "object")
        throw new Error("Invalid resource notification");
      const target = value as ResourceNotificationTarget;
      if (
        ![
          target.connectionId,
          target.hostId,
          target.alertId,
          target.appKey,
        ].every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 512,
        ) ||
        typeof target.title !== "string" ||
        !target.title.trim() ||
        target.title.length > 160 ||
        typeof target.body !== "string" ||
        target.body.length > 300
      )
        throw new Error("Invalid resource notification");
      if (!Notification.isSupported()) return "unavailable";
      const key = `${target.hostId}:${target.alertId}`;
      if (shown.has(key) || (window.isVisible() && window.isFocused()))
        return "skipped";
      shown.add(key);
      if (shown.size > 200) shown.delete(shown.values().next().value!);
      const notification = new Notification({
        title: target.title,
        body: target.body,
        silent: true,
      });
      notification.on("click", () => {
        if (window.isDestroyed()) return;
        window.show();
        window.focus();
        window.webContents.send("resource:notification-open", target);
      });
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve("failed"), 2_000);
        notification.once("show", () => {
          clearTimeout(timer);
          resolve("submitted");
        });
        notification.once("failed", () => {
          clearTimeout(timer);
          resolve("failed");
        });
        notification.show();
      });
    },
  );
}
