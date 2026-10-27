import {
  historyUrl,
  historyTitle,
  type BrowserVisitObservation,
} from "@runweave/shared/browser-history";
import {
  loadState,
  saveState,
  enqueue,
  today,
  type ExtensionState,
} from "./state.js";
import { deliver } from "./native.js";
let chain: Promise<unknown> = Promise.resolve();
let state: ExtensionState;
const ready = loadState().then(async (s) => {
  state = s;
  await saveState(state);
});
function serial(task: () => Promise<unknown>): Promise<unknown> {
  const next = chain.then(async () => {
    await ready;
    return task();
  });
  chain = next.catch(async (e) => {
    if (state) {
      state.error = String(e);
      await saveState(state);
    }
  });
  return next;
}
async function flush() {
  try {
    await deliver(state);
  } catch (e) {
    state.error = `${state.capacityPaused ? "待发送达到 4 MiB，已暂停；旧记录保留。" : ""}本机接收器不可用，记录已暂存：${String(e)}`;
  }
  await saveState(state);
}
async function hash(url: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function title(tabId: number) {
  const current = state.current[String(tabId)];
  if (!current || !state.enabled) return;
  try {
    const before = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    const tab = await chrome.tabs.get(tabId);
    const after = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (
      tab.incognito ||
      !before ||
      !after ||
      before.documentId !== current.documentId ||
      after.documentId !== current.documentId ||
      (await hash(after.url)) !== current.urlHash ||
      tab.url !== after.url ||
      tab.status !== "complete"
    )
      return;
    const next = historyTitle(tab.title ?? "", after.url);
    if (next === current.visit.title) return;
    const update = {
      ...current.visit,
      title: next,
      revision: current.visit.revision + 1,
      observedAt: new Date().toISOString(),
    };
    if (enqueue(state, update)) current.visit = update;
    await saveState(state);
  } catch {
    /* A closed/replaced frame cannot supply a title for this visit. */
  }
}
type Navigation = {
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  timeStamp: number;
  documentLifecycle?: string;
};
function navigation(details: Navigation, sameDocument: boolean) {
  void serial(async () => {
    if (
      !state.enabled ||
      details.frameId !== 0 ||
      (details.documentLifecycle && details.documentLifecycle !== "active")
    )
      return;
    const url = historyUrl(details.url);
    if (!url) return;
    const tab = await chrome.tabs.get(details.tabId).catch(() => null);
    if (!tab || tab.incognito) return;
    const urlHash = await hash(details.url),
      previous = state.current[String(details.tabId)];
    if (
      sameDocument &&
      previous?.documentId === details.documentId &&
      previous.urlHash === urlHash
    )
      return;
    const visit: BrowserVisitObservation = {
      schemaVersion: 1,
      sourceId: state.sourceId,
      browser: state.browser,
      visitId: crypto.randomUUID(),
      revision: 1,
      visitedAt: new Date(details.timeStamp).toISOString(),
      observedAt: new Date().toISOString(),
      url,
      title: null,
      navigation: sameDocument ? "same-document" : "document",
      profileLabel: state.browser === "edge" ? "Edge" : "Chrome",
      actor: "unknown",
    };
    if (enqueue(state, visit))
      state.current[String(details.tabId)] = {
        documentId: details.documentId,
        urlHash,
        visit,
      };
    await saveState(state);
    await title(details.tabId);
  }).catch(() => undefined);
  scheduleFlush();
}
let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void serial(flush).catch(() => undefined);
  }, 800);
}
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0)
    void serial(async () => {
      delete state.current[String(d.tabId)];
      await saveState(state);
    }).catch(() => undefined);
});
chrome.webNavigation.onCommitted.addListener((d) => navigation(d, false));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) =>
  navigation(d, true),
);
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) =>
  navigation(d, true),
);
chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) {
    void serial(() => title(d.tabId)).catch(() => undefined);
    scheduleFlush();
  }
});
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (changes.title !== undefined || changes.status === "complete") {
    void serial(() => title(id)).catch(() => undefined);
    scheduleFlush();
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  void serial(async () => {
    delete state.current[String(id)];
    await saveState(state);
  }).catch(() => undefined);
});
chrome.alarms.create("history-delivery", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "history-delivery") void serial(flush).catch(() => undefined);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("popup.html")
  )
    return;
  void serial(async () => {
    if (message.op === "toggle" && typeof message.enabled === "boolean") {
      state.enabled = message.enabled;
      state.current = {};
      if (state.enabled) {
        state.capacityPaused = false;
        state.error = null;
      }
      await saveState(state);
    } else if (message.op === "flush") await flush();
    else if (message.op !== "status") throw Error("UNKNOWN_OPERATION");
    respond({
      enabled: state.enabled,
      pending: state.queue.length,
      error: state.error,
      lastStoredAt: state.lastStoredAt,
      today:
        state.acknowledged.day === today()
          ? state.acknowledged.visits.length
          : 0,
    });
  }).catch((e) => respond({ error: String(e) }));
  return true;
});
void serial(flush).catch(() => undefined);
