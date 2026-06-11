import {
  app,
  BrowserWindow,
  ipcMain,
  session as electronSession,
  WebContentsView,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTerminalBrowserDeviceState,
  getTerminalBrowserDevicePreset,
  normalizeTerminalBrowserDevicePresetId,
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserDevicePresetId,
  type TerminalBrowserDeviceState,
  type TerminalBrowserHeaderRule,
  type TerminalBrowserHeaderState,
  type TerminalBrowserProxyState,
} from "@browser-viewer/shared";
import {
  normalizeTerminalBrowserPersistedState,
  normalizeTerminalBrowserUrlForStorage,
  selectTerminalBrowserTabsForRestore,
  type TerminalBrowserPersistedState,
  type TerminalBrowserPersistedTabRecord,
} from "./terminal-browser-tabs-state.js";
import { getIsQuitting } from "./app-state.js";

interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  emulationScale?: number;
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
  cdpProxyAttached: boolean;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
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
  deviceState: TerminalBrowserDeviceState;
  emulationScale: number;
  defaultUserAgent: string;
  deviceDebuggerAttached: boolean;
  onDeviceDebuggerDetach: ((event: Electron.Event, reason: string) => void) | null;
  lastActiveAt: number;
  lastKnownUrl: string;
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

const TERMINAL_BROWSER_SESSION_PARTITION = "persist:runweave-terminal-browser";
const TERMINAL_BROWSER_TABS_STORE_FILE = "terminal-browser-tabs.json";
const TERMINAL_BROWSER_PROXY_HOST = "127.0.0.1";
const TERMINAL_BROWSER_PROXY_PORT = 8899;
const TERMINAL_BROWSER_PROXY_RULES =
  `http=${TERMINAL_BROWSER_PROXY_HOST}:${TERMINAL_BROWSER_PROXY_PORT};https=${TERMINAL_BROWSER_PROXY_HOST}:${TERMINAL_BROWSER_PROXY_PORT}`;
const TERMINAL_BROWSER_PROXY_BYPASS_RULES = "<local>";
const TERMINAL_BROWSER_COOKIE_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;

let terminalBrowserProxyEnabled = false;
let terminalBrowserHeaderRules: TerminalBrowserHeaderRule[] = [];
let terminalBrowserHeaderDispatcherRegistered = false;
let terminalBrowserCookiePersistenceRegistered = false;
let terminalBrowserSaveTimer: NodeJS.Timeout | null = null;
let terminalBrowserPersistedStateRestored = false;

const restoringTerminalBrowserWindows = new Set<number>();

function getTerminalBrowserSession(): Electron.Session {
  return electronSession.fromPartition(TERMINAL_BROWSER_SESSION_PARTITION);
}

function getTerminalBrowserTabsStorePath(): string {
  return path.join(app.getPath("userData"), TERMINAL_BROWSER_TABS_STORE_FILE);
}

async function readTerminalBrowserPersistedState(): Promise<TerminalBrowserPersistedState> {
  const storePath = getTerminalBrowserTabsStorePath();
  try {
    const raw = await readFile(storePath, "utf8");
    return normalizeTerminalBrowserPersistedState(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { version: 1, activeTabId: null, tabs: [] };
    }
    console.warn("[electron] failed to read terminal browser tabs state", {
      path: storePath,
      error: error instanceof Error ? error.message : String(error),
    });
    await backupUnreadableTerminalBrowserTabsStore(storePath);
    return { version: 1, activeTabId: null, tabs: [] };
  }
}

async function backupUnreadableTerminalBrowserTabsStore(
  storePath: string,
): Promise<void> {
  const backupPath = `${storePath}.bad-${Date.now()}`;
  try {
    await copyFile(storePath, backupPath);
    console.warn("[electron] backed up unreadable terminal browser tabs state", {
      backupPath,
    });
  } catch (error) {
    console.warn("[electron] failed to back up terminal browser tabs state", {
      path: storePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeTerminalBrowserPersistedState(
  state: TerminalBrowserPersistedState,
): Promise<void> {
  const storePath = getTerminalBrowserTabsStorePath();
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getTerminalBrowserTabRecords(): TerminalBrowserPersistedTabRecord[] {
  const rawRecords: Array<TerminalBrowserPersistedTabRecord & { windowId: number }> =
    [];
  const idCounts = new Map<string, number>();

  for (const [key, entry] of terminalBrowserEntries) {
    const webContents = entry.view.webContents;
    if (!webContents || webContents.isDestroyed()) {
      continue;
    }
    const url = normalizeTerminalBrowserUrlForStorage(
      webContents.getURL() || entry.lastKnownUrl,
    );
    if (!url) {
      continue;
    }
    const prefix = `${entry.windowId}:`;
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    rawRecords.push({
      id,
      windowId: entry.windowId,
      url,
      title: webContents.getTitle(),
      lastActiveAt: entry.lastActiveAt,
    });
  }

  return rawRecords.map(({ windowId, ...record }) => ({
    ...record,
    id:
      (idCounts.get(record.id) ?? 0) > 1
        ? `${windowId}-${record.id}`
        : record.id,
  }));
}

function getTerminalBrowserPersistedState(): TerminalBrowserPersistedState {
  let activeRecord: { windowId: number; tabId: string; lastActiveAt: number } | null =
    null;
  for (const [windowId, tabId] of attachedTerminalBrowserByWindowId) {
    const entry = terminalBrowserEntries.get(makeKeyFromWindowIdAndTabId(windowId, tabId));
    if (!entry) {
      continue;
    }
    if (!activeRecord || entry.lastActiveAt > activeRecord.lastActiveAt) {
      activeRecord = { windowId, tabId, lastActiveAt: entry.lastActiveAt };
    }
  }

  const tabs = getTerminalBrowserTabRecords();
  const activeTabId = activeRecord
    ? tabs.find((tab) => tab.id === activeRecord.tabId)?.id ??
      tabs.find((tab) => tab.id === `${activeRecord.windowId}-${activeRecord.tabId}`)
        ?.id ??
      null
    : null;

  return {
    version: 1,
    activeTabId:
      activeTabId && tabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : (tabs[0]?.id ?? null),
    tabs,
  };
}

function scheduleTerminalBrowserTabsSave(): void {
  if (restoringTerminalBrowserWindows.size > 0) {
    return;
  }
  if (terminalBrowserSaveTimer) {
    clearTimeout(terminalBrowserSaveTimer);
  }
  terminalBrowserSaveTimer = setTimeout(() => {
    terminalBrowserSaveTimer = null;
    const state = getTerminalBrowserPersistedState();
    void writeTerminalBrowserPersistedState(state).catch(() => {
      // Persistence failure should not break the embedded browser.
    });
  }, 150);
}

function getTerminalBrowserProxyState(): TerminalBrowserProxyState {
  return {
    enabled: terminalBrowserProxyEnabled,
    proxyRules: TERMINAL_BROWSER_PROXY_RULES,
    proxyBypassRules: TERMINAL_BROWSER_PROXY_BYPASS_RULES,
  };
}

function getTerminalBrowserHeaderState(): TerminalBrowserHeaderState {
  return {
    rules: terminalBrowserHeaderRules,
  };
}

function getTerminalBrowserCookieExpirationDate(): number {
  return Math.floor(Date.now() / 1000) + TERMINAL_BROWSER_COOKIE_RETENTION_SECONDS;
}

function buildTerminalBrowserCookieUrl(cookie: Electron.Cookie): string | null {
  const domain = cookie.domain?.replace(/^\./, "");
  if (!domain) {
    return null;
  }
  const protocol = cookie.secure ? "https" : "http";
  const pathName = cookie.path?.startsWith("/") ? cookie.path : "/";
  try {
    return new URL(pathName, `${protocol}://${domain}`).toString();
  } catch {
    return null;
  }
}

function ensureTerminalBrowserCookiePersistence(): void {
  if (terminalBrowserCookiePersistenceRegistered) {
    return;
  }

  const browserSession = getTerminalBrowserSession();
  browserSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || cookie.session !== true) {
      return;
    }

    const url = buildTerminalBrowserCookieUrl(cookie);
    if (!url) {
      return;
    }

    void browserSession.cookies
      .set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: getTerminalBrowserCookieExpirationDate(),
      })
      .then(() => browserSession.cookies.flushStore())
      .catch((error) => {
        console.warn("[electron] failed to persist terminal browser session cookie", {
          domain: cookie.domain,
          name: cookie.name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  terminalBrowserCookiePersistenceRegistered = true;
}

function getTerminalBrowserDeviceState(
  entry: TerminalBrowserEntry,
): TerminalBrowserDeviceState {
  return createTerminalBrowserDeviceState(entry.deviceState.presetId);
}

function isTerminalBrowserMobileDeviceState(
  entry: TerminalBrowserEntry,
): boolean {
  return entry.deviceState.mobile === true;
}

function wildcardUrlPatternMatches(pattern: string, url: string): boolean {
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexPattern = `^${escapedPattern.replace(/\*/g, ".*")}$`;
  return new RegExp(regexPattern).test(url);
}

function setRequestHeader(
  requestHeaders: Record<string, string>,
  name: string,
  value: string,
): void {
  const normalizedName = name.toLowerCase();
  for (const existingName of Object.keys(requestHeaders)) {
    if (
      existingName.toLowerCase() === normalizedName &&
      existingName !== name
    ) {
      delete requestHeaders[existingName];
    }
  }
  requestHeaders[name] = value;
}

function ensureTerminalBrowserHeaderDispatcher(): void {
  if (terminalBrowserHeaderDispatcherRegistered) {
    return;
  }

  getTerminalBrowserSession().webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(details.url);
      } catch {
        callback({});
        return;
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        callback({});
        return;
      }

      let requestHeaders: Record<string, string> | null = null;
      for (const rule of terminalBrowserHeaderRules) {
        if (
          !rule.enabled ||
          !wildcardUrlPatternMatches(rule.urlPattern, parsedUrl.toString())
        ) {
          continue;
        }
        requestHeaders ??= { ...details.requestHeaders };
        setRequestHeader(requestHeaders, rule.name, rule.value);
      }

      callback(requestHeaders ? { requestHeaders } : {});
    },
  );
  terminalBrowserHeaderDispatcherRegistered = true;
}

function setTerminalBrowserHeaderRules(
  rules: unknown,
): TerminalBrowserHeaderState {
  terminalBrowserHeaderRules = normalizeTerminalBrowserHeaderRules(rules);
  ensureTerminalBrowserHeaderDispatcher();
  return getTerminalBrowserHeaderState();
}

function reloadTerminalBrowserTabsForProxyChange(): void {
  for (const entry of terminalBrowserEntries.values()) {
    const webContents = entry.view.webContents;
    if (webContents.isDestroyed()) {
      continue;
    }
    const url = webContents.getURL();
    if (!url || url === "about:blank") {
      continue;
    }
    webContents.reload();
  }
}

async function setTerminalBrowserProxyEnabled(
  enabled: boolean,
): Promise<TerminalBrowserProxyState> {
  const browserSession = getTerminalBrowserSession();
  if (enabled) {
    await browserSession.setProxy({
      mode: "fixed_servers",
      proxyRules: TERMINAL_BROWSER_PROXY_RULES,
      proxyBypassRules: TERMINAL_BROWSER_PROXY_BYPASS_RULES,
    });
  } else {
    await browserSession.setProxy({ mode: "direct" });
  }
  await browserSession.closeAllConnections();
  terminalBrowserProxyEnabled = enabled;
  reloadTerminalBrowserTabsForProxyChange();
  return getTerminalBrowserProxyState();
}

function isTerminalBrowserBounds(value: unknown): value is TerminalBrowserBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const hasBounds = ["x", "y", "width", "height"].every(
    (key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
  );
  if (!hasBounds) {
    return false;
  }
  return (
    candidate.emulationScale === undefined ||
    (typeof candidate.emulationScale === "number" &&
      Number.isFinite(candidate.emulationScale) &&
      candidate.emulationScale > 0)
  );
}

function validateTerminalBrowserUrl(url: string): string | null {
  return normalizeTerminalBrowserUrlForStorage(url);
}

function getTerminalBrowserKey(win: BrowserWindow, tabId: string): string {
  return `${win.id}:${tabId}`;
}

function makeKeyFromWindowIdAndTabId(windowId: number, tabId: string): string {
  return `${windowId}:${tabId}`;
}

function getTerminalBrowserSnapshot(
  view: WebContentsView,
  fallbackUrl = "",
): TerminalBrowserSnapshot {
  const history = view.webContents.navigationHistory;
  return {
    url: view.webContents.getURL() || fallbackUrl,
    title: view.webContents.getTitle(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

async function restoreTerminalBrowserTabsForWindow(
  win: BrowserWindow,
): Promise<void> {
  if (terminalBrowserPersistedStateRestored) {
    return;
  }
  terminalBrowserPersistedStateRestored = true;

  if (getTerminalBrowserTabsForWindow(win.id).length > 0) {
    return;
  }

  const state = await readTerminalBrowserPersistedState();
  if (state.tabs.length === 0) {
    return;
  }

  restoringTerminalBrowserWindows.add(win.id);
  try {
    const restoredTabs = selectTerminalBrowserTabsForRestore(
      state.tabs,
      state.activeTabId,
    );
    for (const tab of restoredTabs) {
      const view = getOrCreateTerminalBrowserView(win, tab.id);
      const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tab.id));
      if (!entry) {
        continue;
      }
      entry.lastActiveAt = tab.lastActiveAt;
      entry.lastKnownUrl = tab.url;
      void view.webContents.loadURL(tab.url).catch(() => {
        sendTerminalBrowserTabUpdate(win, tab.id, entry, false);
      });
    }

    const activeTabId =
      state.activeTabId && restoredTabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : (restoredTabs[0]?.id ?? null);
    if (activeTabId) {
      const activeEntry = terminalBrowserEntries.get(
        getTerminalBrowserKey(win, activeTabId),
      );
      if (activeEntry) {
        attachTerminalBrowser(win, activeTabId, activeEntry.view);
      }
    }
  } finally {
    restoringTerminalBrowserWindows.delete(win.id);
  }
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
  const snapshot = getTerminalBrowserSnapshot(entry.view, entry.lastKnownUrl);
  if (snapshot.url) {
    entry.lastKnownUrl = snapshot.url;
  }
  const update: TerminalBrowserUpdate = {
    tabId,
    ...snapshot,
    loading,
    cdpProxyAttached: entry.cdpProxyAttached,
    devtoolsOpen: entry.devtoolsOpen,
    deviceState: getTerminalBrowserDeviceState(entry),
  };
  win.webContents.send("terminal-browser:tab-updated", update);
  scheduleTerminalBrowserTabsSave();
}

function sendTerminalBrowserTabActivatedFromProxy(
  win: BrowserWindow,
  tabId: string,
  entry: TerminalBrowserEntry,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  const snapshot = getTerminalBrowserSnapshot(entry.view, entry.lastKnownUrl);
  if (snapshot.url) {
    entry.lastKnownUrl = snapshot.url;
  }
  const update: TerminalBrowserUpdate = {
    tabId,
    ...snapshot,
    loading: entry.view.webContents.isLoading(),
    cdpProxyAttached: entry.cdpProxyAttached,
    devtoolsOpen: entry.devtoolsOpen,
    deviceState: getTerminalBrowserDeviceState(entry),
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
      partition: TERMINAL_BROWSER_SESSION_PARTITION,
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
    deviceState: createTerminalBrowserDeviceState("desktop"),
    emulationScale: 1,
    defaultUserAgent: view.webContents.getUserAgent(),
    deviceDebuggerAttached: false,
    onDeviceDebuggerDetach: null,
    lastActiveAt: Date.now(),
    lastKnownUrl: "",
  };

  view.webContents.on("devtools-opened", () => {
    entry.devtoolsOpen = true;
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("devtools-closed", () => {
    entry.devtoolsOpen = false;
    sendTerminalBrowserTabUpdate(win, tabId, entry);
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
  entry.lastKnownUrl = url;
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
  if (entry) {
    entry.lastActiveAt = Date.now();
  }
  if (!restoringTerminalBrowserWindows.has(win.id)) {
    scheduleTerminalBrowserTabsSave();
  }
}

function closeTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  options: { persist?: boolean } = {},
): void {
  detachTerminalBrowser(win, tabId);
  const key = getTerminalBrowserKey(win, tabId);
  const entry = terminalBrowserEntries.get(key);
  if (!entry) {
    return;
  }
  if (entry.attached) {
    win.contentView.removeChildView(entry.view);
  }
  detachTerminalBrowserDeviceDebugger(entry);
  terminalBrowserEntries.delete(key);
  terminalBrowserEvents.emit("tab-closed", { targetId: entry.targetId });
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("terminal-browser:tab-closed", { tabId });
  }
  entry.view.webContents.close();
  if (options.persist !== false) {
    scheduleTerminalBrowserTabsSave();
  }
}

export function closeTerminalBrowsersForWindow(windowId: number): void {
  attachedTerminalBrowserByWindowId.delete(windowId);
  for (const [key, entry] of terminalBrowserEntries) {
    if (entry.windowId !== windowId) {
      continue;
    }
    terminalBrowserEntries.delete(key);
    terminalBrowserEvents.emit("tab-closed", { targetId: entry.targetId });
    detachTerminalBrowserDeviceDebugger(entry);
    entry.view.webContents.close();
  }
  terminalBrowserEvents.emit("window-closed", { windowId });
  if (!getIsQuitting()) {
    scheduleTerminalBrowserTabsSave();
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

function clampTerminalBrowserEmulationScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(0.1, Math.min(value, 1));
}

function attachTerminalBrowserDeviceDebugger(entry: TerminalBrowserEntry): void {
  if (entry.deviceDebuggerAttached) {
    return;
  }
  const webContents = entry.view.webContents;
  if (webContents.isDestroyed()) {
    throw new Error("Cannot emulate a closed browser tab");
  }
  if (entry.devtoolsOpen || webContents.isDevToolsOpened()) {
    throw new Error("Cannot enable mobile mode while DevTools is open");
  }
  if (!entry.cdpProxyAttached) {
    try {
      webContents.debugger.attach("1.3");
    } catch (error) {
      throw new Error(
        `Cannot enable mobile mode because the debugger is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  entry.deviceDebuggerAttached = true;
  entry.onDeviceDebuggerDetach = (_event, reason) => {
    entry.deviceDebuggerAttached = false;
    entry.onDeviceDebuggerDetach = null;
    console.info("[electron] terminal browser device debugger detached", {
      targetId: entry.targetId,
      reason,
    });
  };
  webContents.debugger.on("detach", entry.onDeviceDebuggerDetach);
}

function detachTerminalBrowserDeviceDebugger(entry: TerminalBrowserEntry): void {
  if (!entry.deviceDebuggerAttached) {
    return;
  }
  const webContents = entry.view.webContents;
  if (entry.onDeviceDebuggerDetach) {
    webContents.debugger.off("detach", entry.onDeviceDebuggerDetach);
    entry.onDeviceDebuggerDetach = null;
  }
  if (!entry.cdpProxyAttached) {
    try {
      webContents.debugger.detach();
    } catch {
      // Already detached.
    }
  }
  entry.deviceDebuggerAttached = false;
}

async function applyTerminalBrowserDeviceEmulation(
  entry: TerminalBrowserEntry,
  presetId: TerminalBrowserDevicePresetId,
): Promise<TerminalBrowserDeviceState> {
  const preset = getTerminalBrowserDevicePreset(presetId);
  const webContents = entry.view.webContents;
  if (webContents.isDestroyed()) {
    throw new Error("Cannot update a closed browser tab");
  }

  if (!preset.mobile) {
    if (entry.deviceState.mobile) {
      await webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await webContents.debugger.sendCommand("Network.setUserAgentOverride", {
        userAgent: entry.defaultUserAgent,
      });
    }
    if (entry.deviceDebuggerAttached) {
      detachTerminalBrowserDeviceDebugger(entry);
    }
    webContents.setUserAgent(entry.defaultUserAgent);
    entry.emulationScale = 1;
    const state = createTerminalBrowserDeviceState("desktop");
    entry.deviceState = state;
    return state;
  }

  if (entry.devtoolsOpen || webContents.isDevToolsOpened()) {
    throw new Error("Cannot enable mobile mode while DevTools is open");
  }

  const viewport = preset.viewport;
  if (!viewport || !preset.userAgent) {
    throw new Error("Invalid terminal browser device preset");
  }

  attachTerminalBrowserDeviceDebugger(entry);
  webContents.setUserAgent(preset.userAgent);
  await webContents.debugger.sendCommand("Network.setUserAgentOverride", {
    userAgent: preset.userAgent,
    platform: preset.id === "pixel-7" ? "Android" : "iPhone",
  });
  await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: true,
    scale: entry.emulationScale,
  });
  await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    configuration: "mobile",
  });

  const state = createTerminalBrowserDeviceState(preset.id);
  entry.deviceState = state;
  return state;
}

async function updateTerminalBrowserEmulationScale(
  entry: TerminalBrowserEntry,
  emulationScale: number,
): Promise<void> {
  entry.emulationScale = clampTerminalBrowserEmulationScale(emulationScale);
  if (!entry.deviceState.mobile) {
    return;
  }
  await applyTerminalBrowserDeviceEmulation(entry, entry.deviceState.presetId);
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
      url: wc.getURL() || entry.lastKnownUrl,
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
      ...getTerminalBrowserSnapshot(entry.view, entry.lastKnownUrl),
      loading: entry.view.webContents.isLoading(),
      active: activeTabId === tabId,
      cdpProxyAttached: entry.cdpProxyAttached,
      devtoolsOpen: entry.devtoolsOpen,
      deviceState: getTerminalBrowserDeviceState(entry),
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
    entry.lastKnownUrl = safeUrl;
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
    const parts = found.key.split(":");
    const windowId = Number(parts[0]);
    const tabId = parts.slice(1).join(":");
    const win = BrowserWindow.fromId(windowId);
    if (win) {
      sendTerminalBrowserTabUpdate(win, tabId, found.entry);
    }
  }
}

export function registerTerminalBrowserHandlers(): void {
  ensureTerminalBrowserHeaderDispatcher();
  ensureTerminalBrowserCookiePersistence();

  ipcMain.handle("terminal-browser:get-proxy-state", () => {
    return getTerminalBrowserProxyState();
  });

  ipcMain.handle(
    "terminal-browser:set-proxy-enabled",
    async (_event, enabled: unknown): Promise<TerminalBrowserProxyState> => {
      if (typeof enabled !== "boolean") {
        throw new Error("Invalid browser proxy state");
      }
      return await setTerminalBrowserProxyEnabled(enabled);
    },
  );

  ipcMain.handle("terminal-browser:get-header-rules", () => {
    return getTerminalBrowserHeaderState();
  });

  ipcMain.handle(
    "terminal-browser:set-header-rules",
    (_event, rules: unknown): TerminalBrowserHeaderState => {
      return setTerminalBrowserHeaderRules(rules);
    },
  );

  ipcMain.handle("terminal-browser:list-tabs", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return [];
    }
    await restoreTerminalBrowserTabsForWindow(win);
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
    "terminal-browser:get-device-state",
    (event, tabId: string): TerminalBrowserDeviceState => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser device state request");
      }
      const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
      if (!entry || entry.view.webContents.isDestroyed()) {
        return createTerminalBrowserDeviceState("desktop");
      }
      return getTerminalBrowserDeviceState(entry);
    },
  );

  ipcMain.handle(
    "terminal-browser:set-device-state",
    async (
      event,
      tabId: string,
      presetId: unknown,
    ): Promise<TerminalBrowserDeviceState> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser device state request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "update device");
      const normalizedPresetId = normalizeTerminalBrowserDevicePresetId(presetId);
      const nextState = await applyTerminalBrowserDeviceEmulation(
        entry,
        normalizedPresetId,
      );
      sendTerminalBrowserTabUpdate(win, tabId, entry);
      return nextState;
    },
  );

  ipcMain.handle(
    "terminal-browser:navigate",
    async (event, tabId: string, url: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const safeUrl = validateTerminalBrowserUrl(url);
      if (!win || !safeUrl || typeof tabId !== "string") {
        throw new Error("Invalid browser navigation request");
      }

      const view = getOrCreateTerminalBrowserView(win, tabId);
      const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
      if (entry) {
        entry.lastKnownUrl = safeUrl;
      }
      try {
        await view.webContents.loadURL(safeUrl);
      } catch (error) {
        if (!isNavigationAbortError(error)) {
          throw error;
        }
      }
      return getTerminalBrowserSnapshot(view, entry?.lastKnownUrl ?? safeUrl);
    },
  );

  ipcMain.handle(
    "terminal-browser:reload",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser reload request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "reload");
      const { view } = entry;
      view.webContents.reload();
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
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
      const entry = getExistingTerminalBrowserEntry(win, tabId, "go back");
      const { view } = entry;
      if (view.webContents.navigationHistory.canGoBack()) {
        view.webContents.navigationHistory.goBack();
      }
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
    },
  );

  ipcMain.handle(
    "terminal-browser:go-forward",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "go forward");
      const { view } = entry;
      if (view.webContents.navigationHistory.canGoForward()) {
        view.webContents.navigationHistory.goForward();
      }
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
    },
  );

  ipcMain.handle(
    "terminal-browser:set-bounds",
    async (event, tabId: string, bounds: unknown) => {
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
      await updateTerminalBrowserEmulationScale(
        entry,
        clampTerminalBrowserEmulationScale(bounds.emulationScale),
      );
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
    if (isTerminalBrowserMobileDeviceState(entry)) {
      throw new Error("Cannot open DevTools while mobile mode is active");
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
