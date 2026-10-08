import type { BrowserWindow } from "electron";
import { parseLocalBrowserTarget, type DesktopLocalBrowserSource } from "@runweave/shared/browser-local-tunnel";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { DesktopLocalPreview } from "./session.js";
import { getTerminalBrowserKey, terminalBrowserRuntime } from "../runtime.js";
import { attachTerminalBrowser, getExistingTerminalBrowserEntry, getOrCreateTerminalBrowserView } from "../view/lifecycle.js";
import { clearPendingTerminalBrowserTabUpdate } from "../view/updates.js";
import { closeTerminalBrowserDisplayScale } from "../device/display-scale.js";

export function validatePreviewSource(raw: unknown): DesktopLocalBrowserSource {
  const source = raw as DesktopLocalBrowserSource;
  if (!source || ["connectionId", "connectionName", "scope", "apiBase", "accessToken", "terminalSessionId"].some(
    (key) => typeof source[key as keyof DesktopLocalBrowserSource] !== "string" || !source[key as keyof DesktopLocalBrowserSource] || source[key as keyof DesktopLocalBrowserSource].length > 8192,
  )) throw new Error("本地预览缺少有效连接来源。");
  const url = new URL(source.apiBase);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("无效的 Backend 连接。");
  return { ...source };
}

export async function prepareLocalPreview(profileId: TerminalBrowserProfileId, url: string, source?: DesktopLocalBrowserSource) {
  if (!source || !parseLocalBrowserTarget(url)) return undefined;
  const preview = new DesktopLocalPreview(validatePreviewSource(source), profileId, url);
  try { await preview.prepare(); return preview; }
  catch (error) { preview.close(); throw error; }
}

export async function navigateWithLocalPreview(win: BrowserWindow, tabId: string, url: string, source?: DesktopLocalBrowserSource): Promise<void> {
  const previous = getExistingTerminalBrowserEntry(win, tabId, "navigate");
  const generation = (previous.navigationGeneration ?? 0) + 1;
  previous.navigationGeneration = generation;
  const bound = previous.localPreview;
  if (bound && parseLocalBrowserTarget(url)) {
    if (source?.connectionId === bound.source.connectionId) bound.updateSource(validatePreviewSource(source));
    if (new URL(url).origin === new URL(bound.target.url).origin) {
      await previous.view.webContents.loadURL(bound.navigationURL(url)); return;
    }
    source = bound.source;
  }
  const preview = await prepareLocalPreview(previous.profileId, url, source);
  if (win.isDestroyed() || previous.view.webContents.isDestroyed() || previous.navigationGeneration !== generation) { preview?.close(); return; }
  if (preview || bound) {
    const key = getTerminalBrowserKey(win, previous.profileId, tabId);
    // Retain tab/group identity while changing the immutable Chromium Session.
    terminalBrowserRuntime.entries.delete(key);
    terminalBrowserRuntime.dormantTabs.set(key, {
      windowId: win.id, profileId: previous.profileId, tabId, browserGroupId: previous.browserGroupId,
      url: "about:blank", title: "", lastActiveAt: previous.lastActiveAt,
    });
    if (previous.attached) win.contentView.removeChildView(previous.viewportView);
    clearPendingTerminalBrowserTabUpdate(previous);
    closeTerminalBrowserDisplayScale(previous);
    previous.view.webContents.close();
    const view = getOrCreateTerminalBrowserView(win, previous.profileId, tabId, { localPreview: preview });
    attachTerminalBrowser(win, tabId, view);
  }
  const entry = getExistingTerminalBrowserEntry(win, tabId, "navigate");
  entry.lastKnownUrl = url;
  await entry.view.webContents.loadURL(preview?.navigationURL(url) ?? url);
}
