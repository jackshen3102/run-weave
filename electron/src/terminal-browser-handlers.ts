import { BrowserWindow, ipcMain } from "electron";
import {
  createTerminalBrowserDeviceState,
  normalizeTerminalBrowserDevicePresetId,
  type TerminalBrowserDeviceState,
} from "@runweave/shared/terminal-browser-device";
import type { TerminalBrowserHeaderState } from "@runweave/shared/terminal-browser-headers";
import {
  isTerminalBrowserProfileId,
  TERMINAL_BROWSER_PROFILE_IDS,
  type ResolveTerminalBrowserProfileRequest,
} from "@runweave/shared/terminal-browser-profile";
import type { TerminalBrowserDisplayScaleState } from "@runweave/shared/terminal-browser-display-scale";
import {
  deleteTerminalBrowserAnnotation,
  focusTerminalBrowserAnnotation,
  listTerminalBrowserAnnotations,
  setTerminalBrowserAnnotationSelecting,
  setTerminalBrowserAnnotationSubmitting,
  startTerminalBrowserAnnotation,
  stopTerminalBrowserAnnotation,
  submitTerminalBrowserAnnotations,
} from "./terminal-browser-annotation.js";
import {
  applyTerminalBrowserDeviceEmulation,
  clampTerminalBrowserEmulationScale,
  getTerminalBrowserDeviceState,
  isTerminalBrowserMobileDeviceState,
  updateTerminalBrowserEmulationScale,
} from "./terminal-browser-device-emulation.js";
import { ensureTerminalBrowserCookiePersistence } from "./terminal-browser-cookie-persistence.js";
import { setTerminalBrowserDisplayScale } from "./terminal-browser-display-scale.js";
import {
  getTerminalBrowserKey,
  getTerminalBrowserSession,
  findTerminalBrowserEntryForWindow,
  type TerminalBrowserSnapshot,
} from "./terminal-browser-runtime.js";
import {
  getTerminalBrowserHeaderState,
  ensureTerminalBrowserHeaderDispatcher,
  setTerminalBrowserHeaderRules,
} from "./terminal-browser-network.js";
import {
  attachTerminalBrowser,
  clampTerminalBrowserBounds,
  closeTerminalBrowserEntry,
  detachTerminalBrowser,
  getExistingTerminalBrowserEntry,
  isTerminalBrowserBounds,
  materializeTerminalBrowserProfile,
  validateTerminalBrowserUrl,
} from "./terminal-browser-view-lifecycle.js";
import {
  getTerminalBrowserSnapshot,
  isNavigationAbortError,
  sendTerminalBrowserTabUpdate,
} from "./terminal-browser-view-updates.js";
import { popupTerminalBrowserToolMenu } from "./terminal-browser-tool-menu.js";
import { registerTerminalBrowserWorkspaceHandlers } from "./terminal-browser-workspace-handlers.js";
import { restoreTerminalBrowserTabsForWindow } from "./terminal-browser-restore.js";
import {
  getTerminalBrowserProfilePreferences,
  updateTerminalBrowserProfilePreferences,
} from "./terminal-browser-profile-preferences.js";
import {
  getTerminalBrowserProfileRuntimeStates,
  resolveTerminalBrowserProfile,
} from "./terminal-browser-profile-runtime.js";
import { ensureTerminalBrowserWhistle } from "./terminal-browser-whistle-runtime.js";
import { createTerminalBrowserTabFromProxy } from "./terminal-browser-proxy-api.js";

function resolveTerminalBrowserEntryKey(
  win: BrowserWindow,
  tabId: string,
  action: string,
): string {
  const entry = getExistingTerminalBrowserEntry(win, tabId, action);
  return getTerminalBrowserKey(win, entry.profileId, tabId);
}

export function registerTerminalBrowserHandlers(): void {
  for (const profileId of TERMINAL_BROWSER_PROFILE_IDS) {
    ensureTerminalBrowserHeaderDispatcher(profileId);
    ensureTerminalBrowserCookiePersistence(
      getTerminalBrowserSession(profileId),
    );
  }
  registerTerminalBrowserWorkspaceHandlers();

  ipcMain.handle("terminal-browser:open-tool-menu", async (event, request) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return null;
    }
    return await popupTerminalBrowserToolMenu(win, request);
  });

  ipcMain.handle("terminal-browser:get-header-rules", (_event, profileId) => {
    if (!isTerminalBrowserProfileId(profileId)) {
      throw new Error("Invalid Terminal Browser Profile");
    }
    return getTerminalBrowserHeaderState(profileId);
  });

  ipcMain.handle(
    "terminal-browser:set-header-rules",
    (
      _event,
      profileId: unknown,
      rules: unknown,
    ): TerminalBrowserHeaderState => {
      if (!isTerminalBrowserProfileId(profileId)) {
        throw new Error("Invalid Terminal Browser Profile");
      }
      return setTerminalBrowserHeaderRules(profileId, rules);
    },
  );

  ipcMain.handle("terminal-browser:get-profile-preferences", () =>
    getTerminalBrowserProfilePreferences(),
  );
  ipcMain.handle(
    "terminal-browser:update-profile-preferences",
    (_event, update) => updateTerminalBrowserProfilePreferences(update),
  );
  ipcMain.handle("terminal-browser:get-profile-runtimes", () =>
    getTerminalBrowserProfileRuntimeStates(),
  );
  ipcMain.handle(
    "terminal-browser:resolve-profile",
    async (event, request: ResolveTerminalBrowserProfileRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("Terminal browser window is unavailable");
      }
      const resolved = await resolveTerminalBrowserProfile(request);
      await restoreTerminalBrowserTabsForWindow(win);
      materializeTerminalBrowserProfile(win, resolved.profileId, {
        attach: false,
      });
      return resolved;
    },
  );
  ipcMain.handle(
    "terminal-browser:open-whistle-console",
    async (event, profileId: unknown): Promise<void> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !isTerminalBrowserProfileId(profileId)) {
        throw new Error("Invalid Terminal Browser Profile");
      }
      const state = await ensureTerminalBrowserWhistle(profileId);
      const created = await createTerminalBrowserTabFromProxy(
        win.id,
        profileId,
        `http://127.0.0.1:${state.port}/`,
      );
      if (!created) {
        throw new Error("Failed to open the Whistle console");
      }
    },
  );

  ipcMain.handle("terminal-browser:show", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
    if (!entry) {
      return;
    }
    attachTerminalBrowser(win, tabId, entry.view);
    sendTerminalBrowserTabUpdate(win, tabId, entry);
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
      const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
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
      const entry = getExistingTerminalBrowserEntry(
        win,
        tabId,
        "update device",
      );
      const normalizedPresetId =
        normalizeTerminalBrowserDevicePresetId(presetId);
      const nextState = await applyTerminalBrowserDeviceEmulation(
        entry,
        normalizedPresetId,
      );
      sendTerminalBrowserTabUpdate(win, tabId, entry);
      return nextState;
    },
  );

  ipcMain.handle(
    "terminal-browser:set-display-scale",
    async (
      event,
      tabId: string,
      factor: unknown,
    ): Promise<TerminalBrowserDisplayScaleState> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser display scale request");
      }
      const entry = getExistingTerminalBrowserEntry(
        win,
        tabId,
        "update display scale for",
      );
      const state = await setTerminalBrowserDisplayScale(entry, factor);
      sendTerminalBrowserTabUpdate(win, tabId, entry);
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:navigate",
    async (
      event,
      tabId: string,
      url: string,
    ): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const safeUrl = validateTerminalBrowserUrl(url);
      if (!win || !safeUrl || typeof tabId !== "string") {
        throw new Error("Invalid browser navigation request");
      }

      const entry = getExistingTerminalBrowserEntry(win, tabId, "navigate");
      const { view } = entry;
      entry.lastKnownUrl = safeUrl;
      try {
        await view.webContents.loadURL(safeUrl);
      } catch (error) {
        if (!isNavigationAbortError(error)) {
          entry.navigationError = (
            entry.navigationError ||
            (error instanceof Error ? error.message : "Navigation failed")
          ).slice(0, 240);
          sendTerminalBrowserTabUpdate(win, tabId, entry, false);
        }
      }
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
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
    const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
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
      const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
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
    const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
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

  ipcMain.handle(
    "terminal-browser:annotation-start",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser annotation request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "annotate");
      const state = await startTerminalBrowserAnnotation(
        getTerminalBrowserKey(win, entry.profileId, tabId),
        entry.view.webContents,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-stop",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return { active: false, selecting: false, annotations: [] };
      }
      const state = await stopTerminalBrowserAnnotation(
        resolveTerminalBrowserEntryKey(win, tabId, "stop annotation for"),
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-list",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return { active: false, selecting: false, annotations: [] };
      }
      return await listTerminalBrowserAnnotations(
        resolveTerminalBrowserEntryKey(win, tabId, "list annotations for"),
      );
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-set-selecting",
    async (event, tabId: string, selecting: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string" || typeof selecting !== "boolean") {
        throw new Error("Invalid browser annotation selection request");
      }
      const state = await setTerminalBrowserAnnotationSelecting(
        resolveTerminalBrowserEntryKey(
          win,
          tabId,
          "update annotation selection for",
        ),
        selecting,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-set-submitting",
    async (event, tabId: string, submitting: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        typeof tabId !== "string" ||
        typeof submitting !== "boolean"
      ) {
        throw new Error("Invalid browser annotation submission state request");
      }
      const state = await setTerminalBrowserAnnotationSubmitting(
        resolveTerminalBrowserEntryKey(
          win,
          tabId,
          "update annotation submission for",
        ),
        submitting,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-focus",
    async (event, tabId: string, annotationId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        typeof tabId !== "string" ||
        typeof annotationId !== "string"
      ) {
        throw new Error("Invalid browser annotation focus request");
      }
      const state = await focusTerminalBrowserAnnotation(
        resolveTerminalBrowserEntryKey(win, tabId, "focus annotation for"),
        annotationId,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-delete",
    async (event, tabId: string, annotationId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        typeof tabId !== "string" ||
        typeof annotationId !== "string"
      ) {
        throw new Error("Invalid browser annotation delete request");
      }
      const state = await deleteTerminalBrowserAnnotation(
        resolveTerminalBrowserEntryKey(win, tabId, "delete annotation for"),
        annotationId,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-submit",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser annotation submit request");
      }
      const submission = await submitTerminalBrowserAnnotations(
        resolveTerminalBrowserEntryKey(win, tabId, "submit annotations for"),
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state: await listTerminalBrowserAnnotations(
          resolveTerminalBrowserEntryKey(
            win,
            tabId,
            "list submitted annotations for",
          ),
        ),
      });
      return submission;
    },
  );
}
