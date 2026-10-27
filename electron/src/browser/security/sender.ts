import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  CUSTOM_PROTOCOL,
  DEV_SERVER_URL,
  isDev,
} from "../../desktop/config.js";
export function trustedBrowserWindow(
  event: IpcMainInvokeEvent,
): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (
    !win ||
    win.isDestroyed() ||
    event.senderFrame !== win.webContents.mainFrame
  )
    return null;
  try {
    const url = new URL(event.senderFrame.url);
    return (
      isDev
        ? url.origin === new URL(DEV_SERVER_URL).origin
        : url.protocol === `${CUSTOM_PROTOCOL}:` && url.host === "app"
    )
      ? win
      : null;
  } catch {
    return null;
  }
}
