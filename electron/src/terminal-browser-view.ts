import {
  BrowserWindow,
  ipcMain,
  WebContentsView,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TerminalBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TerminalBrowserUpdate extends TerminalBrowserSnapshot {
  tabId: string;
  loading: boolean;
}

export interface TerminalBrowserTabSnapshot extends TerminalBrowserUpdate {
  active: boolean;
  cdpProxyAttached: boolean;
  devtoolsOpen: boolean;
}

interface TerminalBrowserEntry {
  windowId: number;
  view: WebContentsView;
  attached: boolean;
  targetId: string;
  cdpProxyAttached: boolean;
  devtoolsOpen: boolean;
}

export interface TerminalBrowserCdpTarget {
  key: string;
  targetId: string;
  windowId: number;
  url: string;
  title: string;
  webContents: WebContents;
}

const terminalBrowserEntries = new Map<string, TerminalBrowserEntry>();
const attachedTerminalBrowserByWindowId = new Map<number, string>();

export const terminalBrowserEvents = new EventEmitter();

function isTerminalBrowserBounds(value: unknown): value is TerminalBrowserBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
  );
}

function validateTerminalBrowserUrl(url: string): string | null {
  if (typeof url !== "string") {
    return null;
  }
  if (url === "about:blank") {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getTerminalBrowserKey(win: BrowserWindow, tabId: string): string {
  return `${win.id}:${tabId}`;
}

function makeKeyFromWindowIdAndTabId(windowId: number, tabId: string): string {
  return `${windowId}:${tabId}`;
}

function getTerminalBrowserSnapshot(view: WebContentsView): TerminalBrowserSnapshot {
  const history = view.webContents.navigationHistory;
  return {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

function isNavigationAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = String((error as { message?: unknown }).message ?? "");
  return message.includes("ERR_ABORTED") || message.includes("(-3)");
}

function sendTerminalBrowserTabUpdate(
  win: BrowserWindow,
  tabId: string,
  entry: TerminalBrowserEntry,
  loading = entry.view.webContents.isLoading(),
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  const update: TerminalBrowserUpdate = {
    tabId,
    ...getTerminalBrowserSnapshot(entry.view),
    loading,
  };
  win.webContents.send("terminal-browser:tab-updated", update);
}

function sendTerminalBrowserTabActivatedFromProxy(
  win: BrowserWindow,
  tabId: string,
  entry: TerminalBrowserEntry,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  const update: TerminalBrowserUpdate = {
    tabId,
    ...getTerminalBrowserSnapshot(entry.view),
    loading: entry.view.webContents.isLoading(),
  };
  win.webContents.send("terminal-browser:tab-activated-from-proxy", update);
}

function getExistingTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  action: string,
): TerminalBrowserEntry {
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
  if (!entry) {
    throw new Error(`Cannot ${action} closed browser tab`);
  }
  return entry;
}

function getOrCreateTerminalBrowserView(
  win: BrowserWindow,
  tabId: string,
): WebContentsView {
  const key = getTerminalBrowserKey(win, tabId);
  const existing = terminalBrowserEntries.get(key);
  if (existing) {
    return existing.view;
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    // When CDP proxy is attached, deny without opening externally —
    // Playwright controls navigation via CDP commands.
    if (entry.cdpProxyAttached) {
      return { action: "deny" };
    }
    const safeUrl = validateTerminalBrowserUrl(url);
    if (safeUrl) {
      createTerminalBrowserTabFromPageOpen(win, safeUrl);
    }
    return { action: "deny" };
  });
  view.setVisible(false);

  const entry: TerminalBrowserEntry = {
    windowId: win.id,
    view,
    attached: false,
    targetId: randomUUID(),
    cdpProxyAttached: false,
    devtoolsOpen: false,
  };

  view.webContents.on("devtools-opened", () => {
    entry.devtoolsOpen = true;
  });
  view.webContents.on("devtools-closed", () => {
    entry.devtoolsOpen = false;
  });
  view.webContents.on("did-start-loading", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, true);
  });
  view.webContents.on("did-stop-loading", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
  });
  view.webContents.on("did-navigate", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("did-navigate-in-page", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("page-title-updated", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });

  terminalBrowserEntries.set(key, entry);
  return view;
}

function createTerminalBrowserTabFromPageOpen(win: BrowserWindow, url: string): void {
  const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
  const view = getOrCreateTerminalBrowserView(win, tabId);
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
  if (!entry) {
    return;
  }

  attachTerminalBrowser(win, tabId, view);
  win.webContents.send("terminal-browser:tab-created-from-proxy", {
    tabId,
    url,
    title: "",
  });
  void view.webContents.loadURL(url).catch(() => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
  });
}

function detachTerminalBrowser(win: BrowserWindow, tabId?: string): void {
  const attachedTabId = attachedTerminalBrowserByWindowId.get(win.id);
  if (!attachedTabId || (tabId && attachedTabId !== tabId)) {
    return;
  }
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, attachedTabId));
  entry?.view.setVisible(false);
  attachedTerminalBrowserByWindowId.delete(win.id);
}

function attachTerminalBrowser(
  win: BrowserWindow,
  tabId: string,
  view: WebContentsView,
): void {
  const attachedTabId = attachedTerminalBrowserByWindowId.get(win.id);
  if (attachedTabId === tabId) {
    view.setVisible(true);
    return;
  }
  for (const entry of terminalBrowserEntries.values()) {
    if (entry.windowId === win.id) {
      entry.view.setVisible(false);
    }
  }
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
  if (entry && !entry.attached) {
    win.contentView.addChildView(view);
    entry.attached = true;
  }
  view.setVisible(true);
  attachedTerminalBrowserByWindowId.set(win.id, tabId);
}

function closeTerminalBrowserEntry(win: BrowserWindow, tabId: string): void {
  detachTerminalBrowser(win, tabId);
  const key = getTerminalBrowserKey(win, tabId);
  const entry = terminalBrowserEntries.get(key);
  if (!entry) {
    return;
  }
  if (entry.attached) {
    win.contentView.removeChildView(entry.view);
  }
  terminalBrowserEntries.delete(key);
  terminalBrowserEvents.emit("tab-closed", { targetId: entry.targetId });
  entry.view.webContents.close();
}

export function closeTerminalBrowsersForWindow(windowId: number): void {
  attachedTerminalBrowserByWindowId.delete(windowId);
  for (const [key, entry] of terminalBrowserEntries) {
    if (entry.windowId !== windowId) {
      continue;
    }
    terminalBrowserEntries.delete(key);
    terminalBrowserEvents.emit("tab-closed", { targetId: entry.targetId });
    entry.view.webContents.close();
  }
  terminalBrowserEvents.emit("window-closed", { windowId });
}

function clampTerminalBrowserBounds(
  win: BrowserWindow,
  bounds: TerminalBrowserBounds,
): TerminalBrowserBounds {
  const content = win.getContentBounds();
  const maxWidth = Math.max(0, content.width - bounds.x);
  const maxHeight = Math.max(0, content.height - bounds.y);
  return {
    x: Math.max(0, Math.min(Math.round(bounds.x), content.width)),
    y: Math.max(0, Math.min(Math.round(bounds.y), content.height)),
    width: Math.max(0, Math.min(Math.round(bounds.width), maxWidth)),
    height: Math.max(0, Math.min(Math.round(bounds.height), maxHeight)),
  };
}

export function getTerminalBrowserCdpTargets(): TerminalBrowserCdpTarget[] {
  const targets: TerminalBrowserCdpTarget[] = [];
  for (const [key, entry] of terminalBrowserEntries) {
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) {
      continue;
    }
    targets.push({
      key,
      targetId: entry.targetId,
      windowId: entry.windowId,
      url: wc.getURL(),
      title: wc.getTitle(),
      webContents: wc,
    });
  }
  return targets;
}

export function getTerminalBrowserEntryByTargetId(
  targetId: string,
): { key: string; entry: TerminalBrowserEntry } | null {
  for (const [key, entry] of terminalBrowserEntries) {
    if (entry.targetId === targetId) {
      return { key, entry };
    }
  }
  return null;
}

export function getTerminalBrowserEntryByKey(
  key: string,
): TerminalBrowserEntry | null {
  return terminalBrowserEntries.get(key) ?? null;
}

export function getTerminalBrowserTabsForWindow(
  windowId: number,
): TerminalBrowserTabSnapshot[] {
  const activeTabId = attachedTerminalBrowserByWindowId.get(windowId) ?? null;
  const prefix = `${windowId}:`;
  const tabs: TerminalBrowserTabSnapshot[] = [];
  for (const [key, entry] of terminalBrowserEntries) {
    if (entry.windowId !== windowId || !key.startsWith(prefix)) {
      continue;
    }
    const tabId = key.slice(prefix.length);
    tabs.push({
      tabId,
      ...getTerminalBrowserSnapshot(entry.view),
      loading: entry.view.webContents.isLoading(),
      active: activeTabId === tabId,
      cdpProxyAttached: entry.cdpProxyAttached,
      devtoolsOpen: entry.devtoolsOpen,
    });
  }
  return tabs;
}

export async function createTerminalBrowserTabFromProxy(
  windowId: number,
  url: string,
): Promise<{ key: string; targetId: string; webContents: WebContents } | null> {
  const win = BrowserWindow.fromId(windowId);
  if (!win) {
    return null;
  }
  const tabId = `ai-tab-${randomUUID().slice(0, 8)}`;
  const view = getOrCreateTerminalBrowserView(win, tabId);
  const key = makeKeyFromWindowIdAndTabId(windowId, tabId);
  const entry = terminalBrowserEntries.get(key);
  if (!entry) {
    return null;
  }

  attachTerminalBrowser(win, tabId, view);

  const safeUrl = validateTerminalBrowserUrl(url);
  if (safeUrl) {
    const load = view.webContents.loadURL(safeUrl);
    if (safeUrl === "about:blank") {
      await load;
    } else {
      void load.catch(() => {
        // The proxy target remains usable even if the initial navigation fails.
      });
    }
  }

  // Notify the renderer so the frontend tab bar picks up the new tab.
  win.webContents.send("terminal-browser:tab-created-from-proxy", {
    tabId,
    url: safeUrl ?? url,
    title: "",
  });

  return { key, targetId: entry.targetId, webContents: view.webContents };
}

export function closeTerminalBrowserTabFromProxy(targetId: string): boolean {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found) {
    return false;
  }
  const parts = found.key.split(":");
  const windowId = Number(parts[0]);
  const tabId = parts.slice(1).join(":");
  const win = BrowserWindow.fromId(windowId);
  if (!win) {
    return false;
  }
  closeTerminalBrowserEntry(win, tabId);
  return true;
}

export function activateTerminalBrowserTabFromProxy(targetId: string): boolean {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found) {
    return false;
  }
  const parts = found.key.split(":");
  const windowId = Number(parts[0]);
  const tabId = parts.slice(1).join(":");
  const win = BrowserWindow.fromId(windowId);
  if (!win) {
    return false;
  }
  attachTerminalBrowser(win, tabId, found.entry.view);
  sendTerminalBrowserTabActivatedFromProxy(win, tabId, found.entry);
  return true;
}

export function setTerminalBrowserCdpProxyAttached(
  targetId: string,
  attached: boolean,
): void {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (found) {
    found.entry.cdpProxyAttached = attached;
  }
}

export function registerTerminalBrowserHandlers(): void {
  ipcMain.handle("terminal-browser:list-tabs", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return [];
    }
    return getTerminalBrowserTabsForWindow(win.id);
  });

  ipcMain.handle("terminal-browser:show", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const view = getOrCreateTerminalBrowserView(win, tabId);
    attachTerminalBrowser(win, tabId, view);
  });

  ipcMain.handle("terminal-browser:hide", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    detachTerminalBrowser(win, tabId);
  });

  ipcMain.handle(
    "terminal-browser:navigate",
    async (event, tabId: string, url: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const safeUrl = validateTerminalBrowserUrl(url);
      if (!win || !safeUrl || typeof tabId !== "string") {
        throw new Error("Invalid browser navigation request");
      }

      const view = getOrCreateTerminalBrowserView(win, tabId);
      try {
        await view.webContents.loadURL(safeUrl);
      } catch (error) {
        if (!isNavigationAbortError(error)) {
          throw error;
        }
      }
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle(
    "terminal-browser:reload",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser reload request");
      }
      const { view } = getExistingTerminalBrowserEntry(win, tabId, "reload");
      view.webContents.reload();
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle("terminal-browser:stop", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
    entry?.view.webContents.stop();
  });

  ipcMain.handle(
    "terminal-browser:go-back",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const { view } = getExistingTerminalBrowserEntry(win, tabId, "go back");
      if (view.webContents.navigationHistory.canGoBack()) {
        view.webContents.navigationHistory.goBack();
      }
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle(
    "terminal-browser:go-forward",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const { view } = getExistingTerminalBrowserEntry(win, tabId, "go forward");
      if (view.webContents.navigationHistory.canGoForward()) {
        view.webContents.navigationHistory.goForward();
      }
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle(
    "terminal-browser:set-bounds",
    (event, tabId: string, bounds: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return;
      }
      if (bounds === null) {
        detachTerminalBrowser(win, tabId);
        return;
      }
      if (!isTerminalBrowserBounds(bounds)) {
        return;
      }
      const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
      if (!entry) {
        return;
      }
      const nextBounds = clampTerminalBrowserBounds(win, bounds);
      entry.view.setBounds(nextBounds);
    },
  );

  ipcMain.handle("terminal-browser:open-devtools", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
    if (!entry) {
      return;
    }
    if (entry.cdpProxyAttached) {
      throw new Error(
        "Cannot open DevTools while CDP proxy is attached to this tab",
      );
    }
    entry.view.webContents.openDevTools({ mode: "detach" });
  });

  ipcMain.handle("terminal-browser:close-tab", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    closeTerminalBrowserEntry(win, tabId);
  });
}
