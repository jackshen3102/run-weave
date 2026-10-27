import { randomUUID } from "node:crypto";
import {
  historyUrl,
  historyTitle,
  type BrowserVisitObservation,
} from "@runweave/shared/browser-history";
import type { BrowserPluginPage } from "../../contract.js";
import { getBrowserHistoryStatus, recordBrowserHistory } from "./runtime.js";

/** Record commits; view presentation and Activity diagnostic events are not visits. */
export function attachBrowserHistory(page: BrowserPluginPage) {
  const { contents, profileId: profile, displayUrl } = page;
  let current: BrowserVisitObservation | null = null;
  let rawUrl = contents.getURL();
  let generation = 0;
  function save(visit: BrowserVisitObservation) {
    recordBrowserHistory(profile, visit);
  }
  function title() {
    if (
      !current ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame() ||
      contents.getURL() !== rawUrl ||
      !getBrowserHistoryStatus(profile).enabled
    )
      return;
    const value = historyTitle(contents.getTitle(), rawUrl);
    if (value === current.title) return;
    current = {
      ...current,
      revision: current.revision + 1,
      observedAt: new Date().toISOString(),
      title: value,
    };
    save(current);
  }
  function commit(url: string, sameDocument: boolean) {
    if (page.restoring) {
      rawUrl = url;
      current = null;
      return;
    }
    if (sameDocument && url === rawUrl) return;
    rawUrl = url;
    const status = getBrowserHistoryStatus(profile),
      normalized = historyUrl(displayUrl(url));
    if (!status.enabled || !normalized) {
      current = null;
      return;
    }
    const now = new Date().toISOString();
    current = {
      schemaVersion: 1,
      sourceId: status.sourceId,
      browser: "runweave",
      visitId: randomUUID(),
      revision: 1,
      visitedAt: now,
      observedAt: now,
      url: normalized,
      title: null,
      navigation: sameDocument ? "same-document" : "document",
      profileLabel: profile,
      scope: {
        profileId: profile,
        tabId: page.pageId,
        groupId: page.groupId(),
      },
      actor: "unknown",
    };
    save(current);
    const token = generation;
    setImmediate(() => {
      if (token === generation) title();
    });
  }
  page.listen("did-start-navigation", (_e, _url, _sameDocument, mainFrame) => {
    if (!mainFrame) return;
    generation++;
  });
  page.listen("did-navigate", (_e, url) => commit(url, false));
  page.listen("did-navigate-in-page", (_e, url, mainFrame) => {
    if (mainFrame) commit(url, true);
  });
  page.listen("page-title-updated", title);
  page.listen("did-finish-load", title);
  page.listen("did-stop-loading", title);
  return () => {
    current = null;
    generation++;
  };
}
