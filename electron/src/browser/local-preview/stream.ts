import { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
  LOCAL_BROWSER_MAX_BUFFER, LOCAL_BROWSER_MAX_FRAME,
  type DesktopLocalBrowserSource, type LocalBrowserOpen,
} from "@runweave/shared/browser-local-tunnel";

export async function openPreviewStream(source: DesktopLocalBrowserSource, url: string, open: LocalBrowserOpen, signal: AbortSignal): Promise<Duplex> {
  const base = source.apiBase.replace(/\/+$/, "");
  const response = await fetch(`${base}/api/browser/local/desktop/grants`, {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Authorization: `Bearer ${source.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, terminalSessionId: open.terminalSessionId, browserSessionId: open.browserSessionId }),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "电脑版本不支持桌面本地预览，请更新 Backend。" : "本地预览授权失效或服务未启用，请从原终端重新打开。");
  const result = await response.json() as { grant?: string; protocolVersion?: number };
  if (typeof result.grant !== "string" || result.protocolVersion !== 1) throw new Error("电脑本地预览协议不兼容。");
  signal.throwIfAborted();
  const address = new URL(`${base}/ws/browser-local`);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${result.grant}` }, maxPayload: LOCAL_BROWSER_MAX_FRAME, handshakeTimeout: 10_000 });
    let ready = false;
    let outputEnded = false;
    const timeout = setTimeout(() => fail("连接电脑本地服务超时。"), 15_000);
    const abort = () => stream.destroy(new Error("电脑连接已失效。"));
    const stream = new Duplex({
      read() { ws.resume(); },
      write(chunk: Buffer, _encoding, callback) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + chunk.length > LOCAL_BROWSER_MAX_BUFFER) {
          callback(new Error("本地预览通道已断开或缓冲区已满。")); return;
        }
        let offset = 0;
        const send = () => {
          const part = chunk.subarray(offset, offset + LOCAL_BROWSER_MAX_FRAME);
          offset += part.length;
          ws.send(part, { binary: true }, (error) => {
            if (error || offset >= chunk.length) callback(error);
            else send();
          });
        };
        send();
      },
      final(callback) {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"eof"}', callback);
        else callback();
      },
      destroy(error, callback) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        ws.terminate();
        if (!ready) reject(error ?? new Error("本地预览连接已关闭。"));
        callback(error);
      },
    });
    // Keep early errors observed until the HTTP owner attaches its handlers.
    stream.on("error", () => undefined);
    const fail = (message: string) => stream.destroy(new Error(message));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    ws.on("open", () => ws.send(JSON.stringify(open)));
    ws.on("message", (data, binary) => {
      if (binary) {
        if (!ready || outputEnded) { fail("本地预览协议错误。"); return; }
        if (!stream.push(data)) ws.pause();
        return;
      }
      try {
        const control = JSON.parse(data.toString()) as { type: string; code?: string };
        if (control.type === "ready" && !ready) {
          ready = true; clearTimeout(timeout); resolve(stream);
        } else if (control.type === "eof" && ready && !outputEnded) {
          outputEnded = true; stream.push(null);
        } else fail(control.code === "target_unavailable" ? "电脑本地服务未启动，或 HTTPS 证书无效。" : "电脑本地预览连接失效，请从原终端重新打开。");
      } catch { fail("本地预览协议错误。"); }
    });
    ws.on("error", () => fail("无法连接电脑本地预览通道。"));
    ws.on("close", () => {
      if (!outputEnded) fail("电脑本地预览连接已中断。");
    });
  });
}
