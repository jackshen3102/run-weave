import {
  BrowserWindow,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import {
  bookmarkFailure,
  bookmarkUrl,
  type BookmarkMutation,
  type BookmarkResult,
  type BookmarkTargetResult,
} from "@runweave/shared/terminal-browser-bookmarks";
import {
  desktopStateRoot,
  writePrivateJson,
} from "../../desktop/local-state.js";
import {
  CUSTOM_PROTOCOL,
  DEV_SERVER_URL,
  isDev,
} from "../../desktop/config.js";
import {
  findTerminalBrowserEntryForWindow,
  terminalBrowserRuntime,
} from "../runtime.js";
import { BookmarkStore } from "./store.js";
let store: BookmarkStore | undefined;
function getStore(): BookmarkStore {
  return (store ??= new BookmarkStore(
    path.join(desktopStateRoot(), "terminal-browser-bookmarks.v1.json"),
    writePrivateJson,
  ));
}
export function bookmarkSenderWindow(
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
function sanitizedIcon(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)
  )
    return null;
  try {
    const image = nativeImage.createFromDataURL(value);
    const size = image.getSize();
    if (image.isEmpty() || size.width > 512 || size.height > 512) return null;
    const result = image.resize({ width: 16, height: 16 }).toDataURL();
    return result.length <= 8192 ? result : null;
  } catch {
    return null;
  }
}
export function registerBookmarkHandlers(): void {
  ipcMain.handle(
    "terminal-browser:bookmarks-get",
    (event): BookmarkResult =>
      bookmarkSenderWindow(event)
        ? getStore().read()
        : bookmarkFailure("FORBIDDEN", "仅应用主窗口可访问收藏"),
  );
  ipcMain.handle(
    "terminal-browser:bookmarks-mutate",
    (event, raw: BookmarkMutation): BookmarkResult => {
      if (!bookmarkSenderWindow(event))
        return bookmarkFailure("FORBIDDEN", "仅应用主窗口可修改收藏");
      let request = raw;
      if (raw?.operation?.kind === "add-link")
        request = {
          ...raw,
          operation: {
            ...raw.operation,
            faviconDataUrl: sanitizedIcon(raw.operation.faviconDataUrl),
          },
        };
      const before = getStore().read();
      const result = getStore().mutate(request);
      if (
        result.ok &&
        before.ok &&
        result.snapshot.revision > before.snapshot.revision
      )
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          try {
            const url = new URL(win.webContents.getURL());
            if (
              isDev
                ? url.origin === new URL(DEV_SERVER_URL).origin
                : url.protocol === `${CUSTOM_PROTOCOL}:` && url.host === "app"
            )
              win.webContents.send(
                "terminal-browser:bookmarks-changed",
                result.snapshot,
              );
          } catch {
            /* A window may be navigating or closing. */
          }
        }
      return result;
    },
  );
  ipcMain.handle(
    "terminal-browser:bookmark-target",
    (event, tabId: unknown): BookmarkTargetResult => {
      const win = bookmarkSenderWindow(event);
      if (!win) return bookmarkFailure("FORBIDDEN", "仅应用主窗口可读取页面");
      if (typeof tabId !== "string")
        return bookmarkFailure("INVALID_INPUT", "无效的标签页");
      const live = findTerminalBrowserEntryForWindow(win.id, tabId)?.entry;
      const dormant = [...terminalBrowserRuntime.dormantTabs.values()].find(
        (t) => t.windowId === win.id && t.tabId === tabId,
      );
      if (live?.localPreview)
        return bookmarkFailure("INVALID_INPUT", "临时预览暂不支持收藏");
      if (!live && !dormant) return bookmarkFailure("NOT_FOUND", "页面已关闭");
      try {
        const url = bookmarkUrl(
          live ? live.view.webContents.getURL() : dormant?.url,
        );
        const title = live ? live.view.webContents.getTitle() : dormant?.title;
        return {
          ok: true,
          target: {
            tabId,
            url,
            title: [...(title?.trim() || new URL(url).hostname)]
              .slice(0, 200)
              .join(""),
            faviconDataUrl: sanitizedIcon(
              live?.faviconDataUrl ?? dormant?.faviconDataUrl,
            ),
          },
        };
      } catch {
        return bookmarkFailure("INVALID_INPUT", "此页面暂不支持收藏");
      }
    },
  );
}
