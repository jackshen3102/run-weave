import { BrowserWindow } from "electron";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { getTerminalBrowserOwnerWindowId, getScopedTargets } from "./utils.js";
import { restoreTerminalBrowserTabsForWindow } from "../../restore.js";
import { getOrCreateTerminalBrowserView } from "../../view/lifecycle.js";
import { createTerminalBrowserTabFromProxy } from "../../view/index.js";
import {
  ensureTerminalBrowserDormantFallback,
  getTerminalBrowserWorkspaceSnapshot,
} from "../../workspace/index.js";

export function createScopeTargetInitializer(isStopping: () => boolean) {
  // Resolving a group and connecting directly must have the same cold-start
  // behavior. Serialize allocation so concurrent clients do not create two tabs.
  const bootstraps = new Map<string, Promise<void>>();
  const ensureScopeTarget = (
    profileId: TerminalBrowserProfileId,
    groupId: string | null,
  ): Promise<void> => {
    const key = `${profileId}:${groupId ?? ""}`;
    const pending = bootstraps.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const windowId = getTerminalBrowserOwnerWindowId();
      const win = windowId === null ? null : BrowserWindow.fromId(windowId);
      if (!win) throw new Error("No Electron window available");
      await restoreTerminalBrowserTabsForWindow(win);
      if (isStopping() || win.isDestroyed()) return;
      ensureTerminalBrowserDormantFallback(win.id, profileId);
      const workspace = getTerminalBrowserWorkspaceSnapshot(win.id, profileId);
      const tab =
        workspace.tabs.find(
          (tab) =>
            tab.tabId === workspace.activeTabId &&
            (!groupId || tab.browserGroupId === groupId),
        ) ??
        workspace.tabs.find(
          (tab) => !groupId || tab.browserGroupId === groupId,
        );
      if (tab) getOrCreateTerminalBrowserView(win, profileId, tab.tabId);
      if (
        groupId &&
        !getScopedTargets(profileId, groupId).some(
          (target) => target.windowId === win.id,
        )
      ) {
        await createTerminalBrowserTabFromProxy(
          win.id,
          profileId,
          "about:blank",
          groupId,
          { attach: false },
        );
      }
    })().finally(() => bootstraps.delete(key));
    bootstraps.set(key, operation);
    return operation;
  };
  return ensureScopeTarget;
}
