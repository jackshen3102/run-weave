import { session, type Session } from "electron";
import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import {
  parseLocalBrowserTarget, type DesktopLocalBrowserSource, type DesktopLocalBrowserInfo,
} from "@runweave/shared/browser-local-tunnel";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { getTerminalBrowserSession } from "../runtime.js";
import { openPreviewStream } from "./stream.js";
import { ensureTerminalBrowserCertificateTrust } from "../security/certificate.js";

function authSessionId(token: string): string {
  // Change detection only; the Backend authenticates every grant.
  try { return String(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).sid ?? ""); }
  catch { return ""; }
}

/** A private HTTP origin, never a Profile-wide proxy or a same-port SSH forward. */
export class DesktopLocalPreview {
  readonly identity = randomUUID();
  readonly session: Session = session.fromPartition(`local-preview-${this.identity}`);
  readonly target: NonNullable<ReturnType<typeof parseLocalBrowserTarget>>;
  readonly info: DesktopLocalBrowserInfo;
  private readonly secret = randomUUID();
  private readonly abort = new AbortController();
  private readonly server = http.createServer();
  private readonly sockets = new Set<Duplex>();
  private readonly agent = new http.Agent({ keepAlive: false, maxSockets: 32 });
  private origin = "";
  private readonly ownerSessionId: string;
  onFailure?: (message: string) => void;

  constructor(readonly source: DesktopLocalBrowserSource, readonly profileId: TerminalBrowserProfileId, raw: string) {
    const target = parseLocalBrowserTarget(raw);
    if (!target) throw new Error("无效的电脑本地地址。");
    this.target = target;
    this.ownerSessionId = authSessionId(source.accessToken);
    if (!this.ownerSessionId) throw new Error("本地预览需要有效登录，请从原终端重新打开。");
    setMaxListeners(64, this.abort.signal);
    this.info = { connectionId: source.connectionId, connectionName: source.connectionName, originalUrl: target.url };
  }

  async prepare(): Promise<void> {
    this.agent.createConnection = (_options, callback) => {
      void openPreviewStream(this.source, this.target.url, {
        type: "open", version: 1, browserSessionId: this.identity,
        terminalSessionId: this.source.terminalSessionId,
        host: this.target.host, port: this.target.port, secure: this.target.secure,
      }, this.abort.signal).then((stream) => {
        if (this.abort.signal.aborted) { stream.destroy(); callback?.(new Error("预览已关闭"), stream); return; }
        this.track(stream);
        stream.on("error", (error) => this.onFailure?.(error.message));
        callback?.(null, stream);
      }, (error: Error) => { this.onFailure?.(error.message); callback?.(error, undefined as unknown as Duplex); });
      return undefined as unknown as Socket;
    };
    this.server.on("connection", (socket) => this.track(socket));
    this.server.on("request", (req, res) => this.forward(req, res));
    this.server.on("upgrade", (req, socket, head) => this.forward(req, undefined, socket, head));
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(); });
    });
    this.server.on("error", () => this.onFailure?.("本地预览入口不可用。"));
    const port = (this.server.address() as { port: number }).port;
    this.origin = `http://preview-${this.identity}.localhost:${port}`;
    // Copy only the resolved public route. Local preview always stays DIRECT.
    await this.syncProxy();
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.webRequest.onBeforeRequest((details, callback) => {
      const value = details.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
      const local = parseLocalBrowserTarget(value);
      const allowed = this.owns(value);
      callback({ cancel: this.abort.signal.aborted || Boolean(local && !allowed) });
    });
    this.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "x-runweave-preview") delete headers[key];
      if (this.owns(details.url)) headers["X-Runweave-Preview"] = this.secret;
      callback({ requestHeaders: headers });
    });
  }

  async syncProxy(): Promise<void> {
    const route = await getTerminalBrowserSession(this.profileId).resolveProxy("https://example.com");
    if (route === "DIRECT") await this.session.setProxy({ mode: "direct" });
    else {
      const match = /^PROXY (127\.0\.0\.1:\d+)$/.exec(route.trim());
      if (!match) throw new Error("当前 Profile 代理不可用于本地预览。");
      await this.session.setProxy({ mode: "fixed_servers", proxyRules: match[1], proxyBypassRules: "<local>,*.localhost" });
      await ensureTerminalBrowserCertificateTrust(this.profileId, this.session);
    }
  }

  owns(raw: string): boolean {
    try { return new URL(raw.replace(/^ws:/, "http:")).origin === this.origin; } catch { return false; }
  }

  navigationURL(raw: string): string {
    if (this.abort.signal.aborted) throw new Error("原电脑连接已失效，请从终端重新打开。");
    const url = new URL(raw);
    const original = new URL(this.target.url);
    if (url.origin !== original.origin) throw new Error("请从原终端打开新的本地目标；当前预览只授权一个地址和端口。");
    return this.origin + url.pathname + url.search + url.hash;
  }

  displayURL(raw: string): string {
    if (!this.owns(raw)) return raw;
    const url = new URL(raw);
    return new URL(this.target.url).origin + url.pathname + url.search + url.hash;
  }

  updateSource(source: DesktopLocalBrowserSource): void {
    if (source.scope !== this.source.scope || source.apiBase !== this.source.apiBase || authSessionId(source.accessToken) !== this.ownerSessionId) {
      this.invalidate("原电脑连接或登录已变化，请从终端重新打开。");
    } else if (!this.abort.signal.aborted) this.source.accessToken = source.accessToken;
  }

  invalidate(message: string): void {
    this.onFailure?.(message);
    this.close();
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private forward(req: http.IncomingMessage, res?: http.ServerResponse, socket?: Duplex, head?: Buffer): void {
    if (this.abort.signal.aborted || req.headers["x-runweave-preview"] !== this.secret ||
      req.headers.host !== new URL(this.origin).host || !req.url?.startsWith("/") || req.url.startsWith("//")) {
      if (res) { res.writeHead(403); res.end(); } else socket?.destroy();
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: new URL(this.target.url).host };
    delete headers["x-runweave-preview"];
    delete headers["proxy-authorization"];
    const upstream = http.request({ method: req.method, path: req.url, headers, agent: this.agent, host: "127.0.0.1", port: this.target.port });
    upstream.on("error", () => {
      if (res && !res.headersSent) { res.writeHead(502); res.end("电脑本地服务不可用，请从原终端重新打开。"); }
      else res?.destroy();
      socket?.destroy();
    });
    upstream.on("response", (response) => {
      if (!res) { response.destroy(); socket?.destroy(); return; }
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      res.once("close", () => { response.destroy(); upstream.destroy(); });
    });
    if (socket) {
      upstream.on("upgrade", (response, remote, remoteHead) => {
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((s, value, i, all) => i % 2 ? s : s + value + ": " + all[i + 1] + "\r\n", "")}\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head?.length) remote.write(head);
        remote.on("error", () => socket.destroy());
        socket.on("error", () => remote.destroy());
        socket.once("close", () => remote.destroy());
        remote.once("close", () => socket.destroy());
        socket.pipe(remote).pipe(socket);
      });
      upstream.end();
    } else {
      req.once("aborted", () => upstream.destroy());
      req.pipe(upstream);
    }
  }

  close(): void {
    if (this.abort.signal.aborted) return;
    this.onFailure = undefined;
    this.abort.abort();
    this.agent.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    void this.session.closeAllConnections();
    void this.session.clearStorageData();
    this.source.accessToken = "";
  }
}
