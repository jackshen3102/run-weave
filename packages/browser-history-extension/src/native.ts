import {
  HISTORY_HOST,
  HISTORY_BATCH_BYTES,
  historyObservationKey,
  type HistoryBrowser,
} from "@runweave/shared/browser-history";
import { saveState, today, type ExtensionState } from "./state.js";
interface HostResponse {
  id: string;
  ok: boolean;
  browser?: HistoryBrowser;
  acknowledgements?: string[];
  storedAt?: string;
  error?: string;
}
export async function deliver(state: ExtensionState): Promise<void> {
  const port = chrome.runtime.connectNative(HISTORY_HOST);
  const pending = new Map<
    string,
    {
      resolve: (value: HostResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  port.onMessage.addListener((message: HostResponse) => {
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.ok) p.resolve(message);
    else p.reject(Error(message.error ?? "接收器拒绝写入"));
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? "接收器连接已断开";
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(error));
    }
    pending.clear();
  });
  const request = (message: object) =>
    new Promise<HostResponse>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("本机保存超时，保留待发送记录"));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ version: 1, id, ...message });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  try {
    const hello = await request({
      op: "hello",
      sourceId: state.sourceId,
      profileLabel: state.browser === "edge" ? "Edge" : "Chrome",
    });
    if (hello.browser !== state.browser)
      throw Error("接收器浏览器身份不匹配，请重新登记");
    // Each batch is persisted before sending; an unknown ACK always leaves the original keys queued.
    while (state.queue.length) {
      const rows = [];
      for (const row of state.queue.slice(0, 100)) {
        if (
          new TextEncoder().encode(JSON.stringify(rows.concat(row))).length >
          HISTORY_BATCH_BYTES - 1024
        )
          break;
        rows.push(row);
      }
      if (!rows.length) throw Error("待发送记录超出协议大小");
      const response = await request({ op: "append", rows });
      const expected = rows.map(historyObservationKey);
      if (
        JSON.stringify(response.acknowledgements) !== JSON.stringify(expected)
      )
        throw Error("保存回执不匹配，保留队列");
      if (state.acknowledged.day !== today())
        state.acknowledged = { day: today(), visits: [] };
      for (const row of rows)
        if (
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
          }).format(new Date(row.visitedAt)) === today() &&
          !state.acknowledged.visits.includes(row.visitId)
        )
          state.acknowledged.visits.push(row.visitId);
      state.queue.splice(0, rows.length);
      state.lastStoredAt = response.storedAt ?? null;
      await saveState(state);
    }
    state.error = state.capacityPaused
      ? "容量暂停：旧队列已保存，可重新开启记录。"
      : null;
  } finally {
    port.disconnect();
  }
}
