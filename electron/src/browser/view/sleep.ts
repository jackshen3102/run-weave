import type { BrowserWindow } from "electron";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import type { TerminalBrowserSleepResult } from "@runweave/shared/terminal-browser-workspace";
import { hasTerminalBrowserAnnotationSession } from "../annotation/index.js";
import { getTerminalBrowserAutomationSnapshot } from "../automation/runtime.js";
import { closeTerminalBrowserDisplayScale } from "../device/display-scale.js";
import {
  getTerminalBrowserWorkspaceKey,
  terminalBrowserRuntime,
  terminalBrowserEvents,
  type TerminalBrowserEntry,
} from "../runtime.js";
import { scheduleTerminalBrowserTabsSave } from "../tabs/index.js";
import { sendTerminalBrowserWorkspaceChanged } from "../workspace/index.js";
import { isTerminalBrowserPresentationBorrowed } from "./presentation.js";
import { clearPendingTerminalBrowserTabUpdate } from "./updates.js";

// Manual release only. Unknown page state must never imply permission to evict.
const CAN_SLEEP_DOCUMENT = `(() => {
  // Destroying WebContents loses its tab-scoped session storage namespace.
  // Until that namespace can be retained, keep pages with session data alive.
  try {
    if (sessionStorage.length > 0) return false;
  } catch {
    return false;
  }
  const visit = (root) => {
    if (root.querySelector('iframe, frame, audio, video, canvas, input[type="file"]')) return false;
    for (const editor of root.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"])')) {
      if (editor.value || editor.textContent?.trim() || editor.getClientRects().length) return false;
    }
    for (const field of root.querySelectorAll('input, select')) {
      if (field.tagName === 'SELECT') {
        // Let the browser compute defaults, including implicit first selection,
        // disabled options, multiple/size and the last explicit selected option.
        const baseline = field.cloneNode(true);
        baseline.removeAttribute('form');
        const form = document.createElement('form');
        form.append(baseline);
        HTMLFormElement.prototype.reset.call(form);
        if ([...field.options].some((option, index) => option.selected !== baseline.options[index].selected)) return false;
      } else if (['checkbox', 'radio'].includes(field.type)) {
        if (field.checked !== field.defaultChecked) return false;
      } else if (!['hidden', 'button', 'submit', 'reset', 'image'].includes(field.type) && field.value) {
        return false;
      }
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot && !visit(element.shadowRoot)) return false;
    }
    return true;
  };
  return !window.onbeforeunload && document.readyState === 'complete' && visit(document);
})()`;

function isProtected(key: string, entry: TerminalBrowserEntry): boolean {
  const wc = entry.view.webContents;
  return (
    wc.isDestroyed() ||
    wc.isLoading() ||
    wc.isBeingCaptured() ||
    wc.isCurrentlyAudible() ||
    entry.visible ||
    Boolean(entry.sleepPromise) ||
    entry.cdpProxyAttached ||
    entry.devtoolsOpen ||
    wc.debugger.isAttached() ||
    entry.activeDownloads > 0 ||
    entry.popupCount > 0 ||
    entry.deviceState.mobile ||
    entry.displayScale !== 1 ||
    entry.minimumViewportWidth !== null ||
    terminalBrowserRuntime.attachedByWorkspaceKey.get(
      getTerminalBrowserWorkspaceKey(entry.windowId, entry.profileId),
    ) === key.split(":").at(-1) ||
    isTerminalBrowserPresentationBorrowed(entry) ||
    hasTerminalBrowserAnnotationSession(key) ||
    getTerminalBrowserAutomationSnapshot(entry.windowId).connections.some(
      (connection) =>
        connection.profileId === entry.profileId &&
        (!connection.browserGroupId ||
          connection.browserGroupId === entry.browserGroupId),
    )
  );
}

async function sleepEntry(
  win: BrowserWindow,
  key: string,
  entry: TerminalBrowserEntry,
): Promise<boolean> {
  if (isProtected(key, entry)) return false;
  const wc = entry.view.webContents;
  const url = wc.getURL() || entry.lastKnownUrl;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const safe = await Promise.race([
      wc.executeJavaScript(CAN_SLEEP_DOCUMENT),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1500);
      }),
    ]);
    if (
      safe !== true ||
      win.isDestroyed() ||
      terminalBrowserRuntime.entries.get(key) !== entry ||
      isProtected(key, entry) ||
      (wc.getURL() || entry.lastKnownUrl) !== url
    )
      return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
  const tabId = key.slice(`${entry.windowId}:${entry.profileId}:`.length);
  const dormant = {
    windowId: entry.windowId,
    profileId: entry.profileId,
    tabId,
    browserGroupId: entry.browserGroupId,
    url,
    title: wc.getTitle(),
    lastActiveAt: entry.lastActiveAt,
    faviconDataUrl: entry.faviconDataUrl,
    navigationHistory: {
      entries: wc.navigationHistory.getAllEntries(),
      index: wc.navigationHistory.getActiveIndex(),
    },
  };
  let finish!: (slept: boolean) => void;
  entry.sleepPromise = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  wc.once("destroyed", () => {
    // Closing a tab/window while release is pending must not resurrect its metadata.
    if (
      terminalBrowserRuntime.entries.get(key) !== entry ||
      win.isDestroyed()
    ) {
      finish(false);
      return;
    }
    terminalBrowserRuntime.entries.delete(key);
    terminalBrowserRuntime.dormantTabs.set(key, dormant);
    if (entry.attached) win.contentView.removeChildView(entry.viewportView);
    entry.viewportView.removeChildView(entry.view);
    clearPendingTerminalBrowserTabUpdate(entry);
    closeTerminalBrowserDisplayScale(entry);
    terminalBrowserEvents.emit("tab-closed", {
      targetId: entry.targetId,
      profileId: entry.profileId,
      browserGroupId: entry.browserGroupId,
    });
    sendTerminalBrowserWorkspaceChanged(win, entry.profileId);
    scheduleTerminalBrowserTabsSave();
    finish(true);
  });
  // This explicit user operation reloads pages on return. The UI warns about
  // unobservable state; detectable forms/media/automation were excluded above.
  wc.close();
  return entry.sleepPromise;
}

export async function sleepIdleTerminalBrowserTabs(
  win: BrowserWindow,
  profileId: TerminalBrowserProfileId,
): Promise<TerminalBrowserSleepResult> {
  const result = { slept: 0, skipped: 0 };
  const entries = [...terminalBrowserRuntime.entries.entries()]
    .filter(
      ([, entry]) => entry.windowId === win.id && entry.profileId === profileId,
    )
    .sort(([, left], [, right]) => left.lastActiveAt - right.lastActiveAt);
  for (const [key, entry] of entries) {
    if (win.isDestroyed()) break;
    if (await sleepEntry(win, key, entry)) result.slept += 1;
    else result.skipped += 1;
  }
  return result;
}
