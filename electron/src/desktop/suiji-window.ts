import { BrowserWindow, ipcMain } from "electron";
import { CUSTOM_PROTOCOL, DEV_SERVER_URL, isDev } from "./config.js";
import { createWindow, navigateWindowToPath } from "./window.js";

export function registerSuijiWindowHandler(): void {
  let suijiWindow: BrowserWindow | null = null;
  ipcMain.handle("viewer:open-suiji", (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const senderUrl = new URL(event.senderFrame?.url ?? "about:blank");
    const trustedOrigin = isDev
      ? senderUrl.origin === new URL(DEV_SERVER_URL).origin
      : senderUrl.protocol === `${CUSTOM_PROTOCOL}:` &&
        senderUrl.host === "app";
    if (
      !senderWindow ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedOrigin
    ) {
      throw new Error("Suiji windows can only be opened by the local app.");
    }

    if (suijiWindow && !suijiWindow.isDestroyed()) {
      if (
        new URL(suijiWindow.webContents.getURL() || "about:blank").pathname !==
        "/suiji"
      ) {
        navigateWindowToPath(suijiWindow, "/suiji");
      }
      if (suijiWindow.isMinimized()) suijiWindow.restore();
      suijiWindow.show();
      suijiWindow.focus();
      return;
    }

    const win = createWindow({ initialPath: "/suiji" });
    suijiWindow = win;
    win.setTitle("随记");
    win.on("page-title-updated", (event) => event.preventDefault());
    win.once("closed", () => {
      if (suijiWindow === win) suijiWindow = null;
    });
  });
}
