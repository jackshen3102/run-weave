import type { WebContents } from "electron";
import { desktopRuntime } from "../desktop/runtime-state.js";
import {
  recordBrowserNavigationFinished,
  recordBrowserNavigationStarted,
} from "./emitter.js";

/** Track navigation commits, not completion of document/subresource loading. */
export function attachBrowserNavigationActivity(
  contents: WebContents,
  getScope: () => { tabId: string; browserGroupId: string },
): void {
  // Keep document and same-document navigation separate, per WebContents lifetime.
  // Raw URLs are used only in memory; the emitter sanitizes persisted URLs.
  const pending: Array<{
    operationId: string;
    url: string;
    sameDocument: boolean;
  }> = [];

  function finish(
    url: string,
    status: "completed" | "failed" | "cancelled",
    sameDocument?: boolean,
    code?: string,
  ): void {
    const index = pending.findIndex(
      (operation) =>
        operation.url === url &&
        (sameDocument === undefined || operation.sameDocument === sameDocument),
    );
    if (index === -1) {
      // An unmatched native event must not create a fictitious operation.
      desktopRuntime.incidentLogger?.warn("activity.navigation.unmatched_finish", {
        ...getScope(),
        status,
        code,
      });
      return;
    }
    const [operation] = pending.splice(index, 1);
    recordBrowserNavigationFinished({ ...getScope(), ...operation!, url, status, code });
  }

  function cancelPending(code: string, sameDocument?: boolean): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (sameDocument !== undefined && pending[index]!.sameDocument !== sameDocument) continue;
      const [operation] = pending.splice(index, 1);
      recordBrowserNavigationFinished({
        ...getScope(),
        ...operation!,
        status: "cancelled",
        code,
      });
    }
  }

  contents.on("did-start-navigation", (_event, url, sameDocument, isMainFrame) => {
    if (!isMainFrame) return;
    // Chromium may omit failure events for an uncommitted, superseded navigation.
    cancelPending("navigation_superseded", sameDocument);
    pending.push({
      operationId: recordBrowserNavigationStarted({ ...getScope(), url }),
      url,
      sameDocument,
    });
  });
  contents.on("did-redirect-navigation", (_event, url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    // HTTP redirects continue the current document navigation, not a new one.
    const operation = [...pending].reverse().find((item) => !item.sameDocument);
    if (operation) operation.url = url;
  });
  contents.on("did-navigate", (_event, url) => {
    finish(url, "completed", false);
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) finish(url, "completed", true);
  });
  // Use navigation failures, not did-fail-load (which can fire after a commit).
  contents.on(
    "did-fail-provisional-load",
    (_event, errorCode, errorDescription, url, isMainFrame) => {
      if (!isMainFrame) return;
      // An old abort must not consume a newer same-URL navigation still loading.
      if (errorCode === -3 && contents.isLoadingMainFrame()) return;
      finish(
        url,
        errorCode === -3 ? "cancelled" : "failed",
        undefined,
        errorDescription || String(errorCode),
      );
    },
  );
  contents.on("did-stop-loading", () => {
    // Electron 44 can omit provisional failures for uncommitted cancellations.
    if (!contents.isLoadingMainFrame()) cancelPending("navigation_stopped");
  });
  contents.on("render-process-gone", () => cancelPending("render_process_gone"));
  contents.once("destroyed", () => cancelPending("web_contents_destroyed"));
}
