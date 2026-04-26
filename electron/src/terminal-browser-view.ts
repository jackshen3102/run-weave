import { BrowserWindow, ipcMain, shell, WebContentsView } from "electron";

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

interface TerminalBrowserEntry {
  windowId: number;
  view: WebContentsView;
  attached: boolean;
}

const terminalBrowserEntries = new Map<string, TerminalBrowserEntry>();
const attachedTerminalBrowserByWindowId = new Map<number, string>();

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

function getTerminalBrowserSnapshot(view: WebContentsView): TerminalBrowserSnapshot {
  return {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    canGoBack: view.webContents.canGoBack(),
    canGoForward: view.webContents.canGoForward(),
  };
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
    const safeUrl = validateTerminalBrowserUrl(url);
    if (safeUrl) {
      void shell.openExternal(safeUrl);
    }
    return { action: "deny" };
  });
  view.setVisible(false);
  terminalBrowserEntries.set(key, { windowId: win.id, view, attached: false });
  return view;
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
  entry.view.webContents.close();
}

export function closeTerminalBrowsersForWindow(windowId: number): void {
  attachedTerminalBrowserByWindowId.delete(windowId);
  for (const [key, entry] of terminalBrowserEntries) {
    if (entry.windowId !== windowId) {
      continue;
    }
    terminalBrowserEntries.delete(key);
    entry.view.webContents.close();
  }
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

export function registerTerminalBrowserHandlers(): void {
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
      await view.webContents.loadURL(safeUrl);
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
      if (view.webContents.canGoBack()) {
        view.webContents.goBack();
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
      if (view.webContents.canGoForward()) {
        view.webContents.goForward();
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
    entry?.view.webContents.openDevTools({ mode: "detach" });
  });

  ipcMain.handle("terminal-browser:close-tab", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    closeTerminalBrowserEntry(win, tabId);
  });
}
