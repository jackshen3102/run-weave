import {
  HISTORY_QUEUE_BYTES,
  type BrowserVisitObservation,
  type HistoryBrowser,
} from "@runweave/shared/browser-history";
export interface CurrentVisit {
  documentId: string;
  urlHash: string;
  visit: BrowserVisitObservation;
}
export interface ExtensionState {
  version: 1;
  sourceId: string;
  browser: HistoryBrowser;
  enabled: boolean;
  queue: BrowserVisitObservation[];
  current: Record<string, CurrentVisit>;
  error: string | null;
  capacityPaused: boolean;
  acknowledged: { day: string; visits: string[] };
  lastStoredAt: string | null;
}
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
}
export async function loadState(): Promise<ExtensionState> {
  const saved = (await chrome.storage.local.get("historyState"))
    .historyState as ExtensionState | undefined;
  if (saved) {
    if (saved.version !== 1) throw Error("请更新扩展：存储格式不受支持");
    return saved;
  }
  return {
    version: 1,
    sourceId: crypto.randomUUID(),
    browser: navigator.userAgent.includes("Edg/") ? "edge" : "chrome",
    enabled: true,
    queue: [],
    current: {},
    error: null,
    capacityPaused: false,
    acknowledged: { day: today(), visits: [] },
    lastStoredAt: null,
  };
}
export const saveState = (state: ExtensionState) =>
  chrome.storage.local.set({ historyState: state });
export function enqueue(
  state: ExtensionState,
  visit: BrowserVisitObservation,
): boolean {
  if (
    new TextEncoder().encode(JSON.stringify([...state.queue, visit])).length >
    HISTORY_QUEUE_BYTES
  ) {
    state.enabled = false;
    state.capacityPaused = true;
    state.error =
      "待发送数据达到 4 MiB，已暂停；旧记录保留。请恢复接收器后重新开启。";
    return false;
  }
  state.queue.push(visit);
  return true;
}
