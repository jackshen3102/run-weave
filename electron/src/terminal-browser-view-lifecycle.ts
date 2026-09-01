import { BrowserWindow, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { createTerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import { DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE } from "@runweave/shared/terminal-browser-display-scale";
import {
  getTerminalBrowserProfileConfig,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import {
  clearTerminalBrowserAnnotation,
  clearTerminalBrowserAnnotationsForWindow,
} from "./terminal-browser-annotation.js";
import { getIsQuitting } from "./app-state.js";
import { closeTerminalBrowserDisplayScale } from "./terminal-browser-display-scale.js";
import {
  createTerminalBrowserGroupId,
  findTerminalBrowserEntryForWindow,
  getTerminalBrowserKey,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserEvents,
  terminalBrowserRuntime,
  type TerminalBrowserEntry,
} from "./terminal-browser-runtime.js";
import { scheduleTerminalBrowserTabsSave } from "./terminal-browser-tabs.js";
import {
  clearTerminalBrowserWorkspaces,
  ensureTerminalBrowserDormantFallback,
  getOrderedTerminalBrowserTabIds,
  maybeAutomaticallyNameTerminalBrowserGroup,
  registerTerminalBrowserTab,
  removeTerminalBrowserTabFromWorkspace,
  sendTerminalBrowserWorkspaceChanged,
} from "./terminal-browser-workspace.js";
import { updateTerminalBrowserFavicon } from "./terminal-browser-favicon.js";
import {
  configureTerminalBrowserPopupWindow,
  createTerminalBrowserPopupWindowOptions,
  openTerminalBrowserExternalUrl,
} from "./terminal-browser-popup.js";
import {
  clearPendingTerminalBrowserTabUpdate,
  clearTerminalBrowserAnnotationAndNotify,
  sendTerminalBrowserTabUpdate,
} from "./terminal-browser-view-updates.js";
import {
  recordBrowserNavigationFinished,
  recordBrowserNavigationStarted,
  recordBrowserTabEvent,
} from "./activity-emitter.js";
import {
  attachTerminalBrowser,
  detachTerminalBrowser,
} from "./terminal-browser-view-attachment.js";
import { validateTerminalBrowserUrl } from "./terminal-browser-view-helpers.js";

export {
  attachTerminalBrowser,
  detachTerminalBrowser,
} from "./terminal-browser-view-attachment.js";
export {
  clampTerminalBrowserBounds,
  getExistingTerminalBrowserEntry,
  isTerminalBrowserBounds,
  validateTerminalBrowserUrl,
} from "./terminal-browser-view-helpers.js";

export function getOrCreateTerminalBrowserView(
  win: BrowserWindow,
  profileId: TerminalBrowserProfileId,
  tabId: string,
  options: {
    browserGroupId?: string;
    openerTabId?: string;
    notifyWorkspace?: boolean;
  } = {},
): WebContentsView {
  const key = getTerminalBrowserKey(win, profileId, tabId);
  const existing = terminalBrowserRuntime.entries.get(key);
  if (existing) {
    return existing.view;
  }
  const dormant = terminalBrowserRuntime.dormantTabs.get(key);

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getTerminalBrowserProfileConfig(profileId).partition,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    const safeUrl = validateTerminalBrowserUrl(url);
    if (!safeUrl) {
      openTerminalBrowserExternalUrl(url);
      return { action: "deny" };
    }
    // `window.open(url, name, "width=...,height=...")` reports `new-window`;
    // keep those as real popup windows so OAuth / auth flows that rely on
    // `window.opener` and `postMessage` callbacks keep working. Plain
    // `target="_blank"` / tab-style opens report `foreground-tab` /
    // `background-tab` — surface those as a new tab in the right-side panel
    // instead of spawning a separate window.
    //
    // This holds even when the CDP proxy is attached: the page-opened tab
    // inherits the opener's `browserGroupId`, so it stays within the same
    // proxy control group and a connected client still discovers it via
    // `Target.targetCreated`. A human clicking a link must always be able to
    // open it, regardless of whether an agent is driving this tab.
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: createTerminalBrowserPopupWindowOptions(
          win,
          profileId,
        ),
      };
    }
    createTerminalBrowserTabFromPageOpen(
      win,
      profileId,
      safeUrl,
      entry.browserGroupId,
      tabId,
    );
    return { action: "deny" };
  });
  view.webContents.on("did-create-window", (popupWindow) => {
    configureTerminalBrowserPopupWindow(win, popupWindow, profileId);
  });
  view.setVisible(false);

  const entry: TerminalBrowserEntry = {
    windowId: win.id,
    profileId,
    view,
    attached: false,
    visible: false,
    targetId: randomUUID(),
    browserGroupId:
      options.browserGroupId ??
      dormant?.browserGroupId ??
      createTerminalBrowserGroupId(),
    faviconDataUrl: null,
    faviconGeneration: 0,
    navigationError: null,
    cdpProxyAttached: false,
    mcpActivityUntil: null,
    devtoolsOpen: false,
    deviceState: createTerminalBrowserDeviceState("desktop"),
    displayScale: DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
    emulationScale: 1,
    automationDeviceMetrics: null,
    metricsMutationQueue: Promise.resolve(),
    metricsMutationClosed: false,
    defaultUserAgent: view.webContents.getUserAgent(),
    deviceDebuggerAttached: false,
    onDeviceDebuggerDetach: null,
    lastActiveAt: dormant?.lastActiveAt ?? Date.now(),
    lastKnownUrl: dormant?.url ?? "about:blank",
    lastSentUpdateKey: null,
    lastSentUpdateAt: 0,
    pendingUpdate: null,
    pendingUpdateTimer: null,
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
  view.webContents.on(
    "did-start-navigation",
    (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        entry.faviconGeneration += 1;
        // A same-origin page can intentionally have no favicon. Keeping the
        // previous document's icon would misidentify that page until another
        // favicon event happens (and Chromium may not emit one for "no icon").
        entry.faviconDataUrl = null;
        entry.navigationError = null;
        sendTerminalBrowserTabUpdate(win, tabId, entry, true);
        recordBrowserNavigationStarted({
          tabId,
          browserGroupId: entry.browserGroupId,
          url,
        });
      }
    },
  );
  view.webContents.on("did-stop-loading", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
    if (
      maybeAutomaticallyNameTerminalBrowserGroup(
        win.id,
        profileId,
        entry.browserGroupId,
        view.webContents.getTitle(),
        view.webContents.getURL() || entry.lastKnownUrl,
      )
    ) {
      sendTerminalBrowserWorkspaceChanged(win, profileId);
      scheduleTerminalBrowserTabsSave();
    }
  });
  view.webContents.on("did-navigate", (_event, url) => {
    entry.navigationError = null;
    clearTerminalBrowserAnnotationAndNotify(win, tabId);
    sendTerminalBrowserTabUpdate(win, tabId, entry);
    recordBrowserNavigationFinished({
      tabId,
      browserGroupId: entry.browserGroupId,
      url,
      status: "completed",
    });
  });
  view.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode !== -3) {
        entry.navigationError = (errorDescription || String(errorCode)).slice(
          0,
          240,
        );
        sendTerminalBrowserTabUpdate(win, tabId, entry, false);
      }
      recordBrowserNavigationFinished({
        tabId,
        browserGroupId: entry.browserGroupId,
        url: validatedURL,
        status: errorCode === -3 ? "cancelled" : "failed",
        code: errorDescription || String(errorCode),
      });
    },
  );
  view.webContents.on("did-navigate-in-page", () => {
    entry.navigationError = null;
    clearTerminalBrowserAnnotationAndNotify(win, tabId);
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("page-title-updated", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry);
    if (
      maybeAutomaticallyNameTerminalBrowserGroup(
        win.id,
        profileId,
        entry.browserGroupId,
        view.webContents.getTitle(),
        view.webContents.getURL() || entry.lastKnownUrl,
      )
    ) {
      sendTerminalBrowserWorkspaceChanged(win, profileId);
      scheduleTerminalBrowserTabsSave();
    }
  });
  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    const generation = entry.faviconGeneration;
    void updateTerminalBrowserFavicon(entry, favicons, generation, () => {
      sendTerminalBrowserTabUpdate(win, tabId, entry);
    });
  });

  terminalBrowserRuntime.entries.set(key, entry);
  if (dormant) {
    terminalBrowserRuntime.dormantTabs.delete(key);
  } else {
    registerTerminalBrowserTab(
      win.id,
      profileId,
      tabId,
      entry.browserGroupId,
      options.openerTabId,
    );
  }
  recordBrowserTabEvent({
    eventName: "browser.tab.created",
    tabId,
    browserGroupId: entry.browserGroupId,
    reason: options.openerTabId ? "page_open" : "user_or_restore",
  });
  view.webContents.once("destroyed", () => {
    if (terminalBrowserRuntime.entries.get(key) !== entry) {
      return;
    }
    recordBrowserTabEvent({
      eventName: "browser.tab.closed",
      tabId,
      browserGroupId: entry.browserGroupId,
      reason: "web_contents_destroyed",
    });
    const orderedTabIds = getOrderedTerminalBrowserTabIds(win.id, profileId);
    const closingIndex = orderedTabIds.indexOf(tabId);
    const wasActive =
      terminalBrowserRuntime.attachedByWorkspaceKey.get(
        getTerminalBrowserWorkspaceKey(win.id, profileId),
      ) === tabId;
    terminalBrowserRuntime.entries.delete(key);
    if (wasActive) {
      terminalBrowserRuntime.attachedByWorkspaceKey.delete(
        getTerminalBrowserWorkspaceKey(win.id, profileId),
      );
    }
    removeTerminalBrowserTabFromWorkspace(win.id, profileId, tabId);
    clearPendingTerminalBrowserTabUpdate(entry);
    closeTerminalBrowserDisplayScale(entry);
    clearTerminalBrowserAnnotation(key);
    terminalBrowserEvents.emit("tab-closed", {
      targetId: entry.targetId,
      profileId,
      browserGroupId: entry.browserGroupId,
    });
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      const remainingTabIds = getOrderedTerminalBrowserTabIds(
        win.id,
        profileId,
      );
      if (remainingTabIds.length === 0) {
        ensureTerminalBrowserFallback(win, profileId, {
          emitWorkspace: false,
        });
      } else if (wasActive) {
        const nextTabId =
          remainingTabIds[Math.min(closingIndex, remainingTabIds.length - 1)]!;
        const nextEntry = terminalBrowserRuntime.entries.get(
          getTerminalBrowserKey(win, profileId, nextTabId),
        );
        if (nextEntry) {
          attachTerminalBrowser(win, nextTabId, nextEntry.view, {
            emitWorkspace: false,
            persist: false,
          });
        }
      }
      sendTerminalBrowserWorkspaceChanged(win, profileId);
    }
    scheduleTerminalBrowserTabsSave();
  });
  if (options.notifyWorkspace === true) {
    sendTerminalBrowserWorkspaceChanged(win, profileId);
    scheduleTerminalBrowserTabsSave();
  }
  if (!dormant) {
    void view.webContents.loadURL("about:blank").catch(() => undefined);
  }
  return view;
}

export function createTerminalBrowserTabFromPageOpen(
  win: BrowserWindow,
  profileId: TerminalBrowserProfileId,
  url: string,
  browserGroupId: string,
  openerTabId?: string,
): void {
  const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
  const view = getOrCreateTerminalBrowserView(win, profileId, tabId, {
    browserGroupId,
    openerTabId,
  });
  const entry = terminalBrowserRuntime.entries.get(
    getTerminalBrowserKey(win, profileId, tabId),
  );
  if (!entry) {
    return;
  }

  attachTerminalBrowser(win, tabId, view);
  entry.lastKnownUrl = url;
  void view.webContents.loadURL(url).catch(() => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
  });
}

export function ensureTerminalBrowserFallback(
  win: BrowserWindow,
  profileId: TerminalBrowserProfileId,
  options: { emitWorkspace?: boolean } = {},
): string {
  const existingTabId = getOrderedTerminalBrowserTabIds(win.id, profileId)[0];
  if (existingTabId) {
    return existingTabId;
  }
  const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
  const view = getOrCreateTerminalBrowserView(win, profileId, tabId, {
    notifyWorkspace: false,
  });
  attachTerminalBrowser(win, tabId, view, {
    emitWorkspace: false,
    persist: false,
  });
  if (options.emitWorkspace !== false) {
    sendTerminalBrowserWorkspaceChanged(win, profileId);
    scheduleTerminalBrowserTabsSave();
  }
  return tabId;
}

export function materializeTerminalBrowserProfile(
  win: BrowserWindow,
  profileId: TerminalBrowserProfileId,
  options: { attach?: boolean } = {},
): string {
  const fallbackTabId = ensureTerminalBrowserDormantFallback(
    win.id,
    profileId,
  );
  const selectedTabId =
    terminalBrowserRuntime.attachedByWorkspaceKey.get(
      getTerminalBrowserWorkspaceKey(win.id, profileId),
    ) ?? getOrderedTerminalBrowserTabIds(win.id, profileId)[0];

  for (const tabId of getOrderedTerminalBrowserTabIds(win.id, profileId)) {
    const key = getTerminalBrowserKey(win, profileId, tabId);
    const dormant = terminalBrowserRuntime.dormantTabs.get(key);
    if (!dormant) {
      continue;
    }
    const view = getOrCreateTerminalBrowserView(win, profileId, tabId, {
      browserGroupId: dormant.browserGroupId,
      notifyWorkspace: false,
    });
    const entry = terminalBrowserRuntime.entries.get(key);
    if (!entry) {
      continue;
    }
    entry.lastKnownUrl = dormant.url;
    void view.webContents.loadURL(dormant.url).catch(() => {
      sendTerminalBrowserTabUpdate(win, tabId, entry, false);
    });
  }

  const tabId = selectedTabId ?? fallbackTabId;
  const entry = terminalBrowserRuntime.entries.get(
    getTerminalBrowserKey(win, profileId, tabId),
  );
  if (entry && options.attach !== false) {
    attachTerminalBrowser(win, tabId, entry.view, {
      emitWorkspace: false,
      persist: false,
    });
  }
  return tabId;
}

export function closeTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  options: {
    persist?: boolean;
    emitWorkspace?: boolean;
    ensureFallback?: boolean;
    selectFallback?: boolean;
  } = {},
): void {
  const found = findTerminalBrowserEntryForWindow(win, tabId);
  const dormantFound = [...terminalBrowserRuntime.dormantTabs.entries()].find(
    ([, dormant]) => dormant.windowId === win.id && dormant.tabId === tabId,
  );
  const profileId = found?.entry.profileId ?? dormantFound?.[1].profileId;
  if (!profileId) {
    return;
  }
  const workspaceKey = getTerminalBrowserWorkspaceKey(win.id, profileId);
  const orderedTabIds = getOrderedTerminalBrowserTabIds(win.id, profileId);
  const closingIndex = orderedTabIds.indexOf(tabId);
  const wasActive =
    terminalBrowserRuntime.attachedByWorkspaceKey.get(workspaceKey) === tabId;
  detachTerminalBrowser(win, tabId);
  if (wasActive) {
    terminalBrowserRuntime.attachedByWorkspaceKey.delete(workspaceKey);
  }
  const key = getTerminalBrowserKey(win, profileId, tabId);
  const entry = terminalBrowserRuntime.entries.get(key);
  if (!entry) {
    if (!dormantFound) {
      return;
    }
    terminalBrowserRuntime.dormantTabs.delete(key);
    removeTerminalBrowserTabFromWorkspace(win.id, profileId, tabId);
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      if (
        getOrderedTerminalBrowserTabIds(win.id, profileId).length === 0 &&
        options.ensureFallback !== false
      ) {
        ensureTerminalBrowserFallback(win, profileId, {
          emitWorkspace: false,
        });
      }
      if (options.emitWorkspace !== false) {
        sendTerminalBrowserWorkspaceChanged(win, profileId);
      }
    }
    if (options.persist !== false) {
      scheduleTerminalBrowserTabsSave();
    }
    return;
  }
  recordBrowserTabEvent({
    eventName: "browser.tab.closed",
    tabId,
    browserGroupId: entry.browserGroupId,
    reason: "user",
  });
  if (entry.attached) {
    win.contentView.removeChildView(entry.view);
  }
  clearPendingTerminalBrowserTabUpdate(entry);
  closeTerminalBrowserDisplayScale(entry);
  terminalBrowserRuntime.entries.delete(key);
  removeTerminalBrowserTabFromWorkspace(win.id, profileId, tabId);
  clearTerminalBrowserAnnotation(key);
  terminalBrowserEvents.emit("tab-closed", {
    targetId: entry.targetId,
    profileId,
    browserGroupId: entry.browserGroupId,
  });
  entry.view.webContents.close();
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    const remainingTabIds = getOrderedTerminalBrowserTabIds(win.id, profileId);
    if (remainingTabIds.length === 0 && options.ensureFallback !== false) {
      ensureTerminalBrowserFallback(win, profileId, { emitWorkspace: false });
    } else if (
      wasActive &&
      remainingTabIds.length > 0 &&
      options.selectFallback !== false
    ) {
      const nextTabId =
        remainingTabIds[Math.min(closingIndex, remainingTabIds.length - 1)]!;
      const nextEntry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, profileId, nextTabId),
      );
      if (nextEntry) {
        attachTerminalBrowser(win, nextTabId, nextEntry.view, {
          emitWorkspace: false,
          persist: false,
        });
      }
    }
    if (options.emitWorkspace !== false) {
      sendTerminalBrowserWorkspaceChanged(win, profileId);
    }
  }
  if (options.persist !== false) {
    scheduleTerminalBrowserTabsSave();
  }
}

export function closeTerminalBrowsersForWindow(windowId: number): void {
  clearTerminalBrowserWorkspaces(windowId);
  clearTerminalBrowserAnnotationsForWindow(windowId);
  for (const [key, dormant] of terminalBrowserRuntime.dormantTabs) {
    if (dormant.windowId === windowId) {
      terminalBrowserRuntime.dormantTabs.delete(key);
    }
  }
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    if (entry.windowId !== windowId) {
      continue;
    }
    terminalBrowserRuntime.entries.delete(key);
    clearTerminalBrowserAnnotation(key);
    terminalBrowserEvents.emit("tab-closed", {
      targetId: entry.targetId,
      profileId: entry.profileId,
      browserGroupId: entry.browserGroupId,
    });
    clearPendingTerminalBrowserTabUpdate(entry);
    closeTerminalBrowserDisplayScale(entry);
    entry.view.webContents.close();
  }
  terminalBrowserEvents.emit("window-closed", { windowId });
  // Keep the last persisted workspace when an external supervisor terminates
  // the desktop without Electron receiving `before-quit`. If another window
  // remains, rewrite the aggregate snapshot so the closed window is removed.
  if (!getIsQuitting() && terminalBrowserRuntime.workspaceByKey.size > 0) {
    scheduleTerminalBrowserTabsSave();
  }
}
