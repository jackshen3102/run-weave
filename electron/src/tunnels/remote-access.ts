import { reverseRelayCommand } from "./reverse-relay-command.js";
import http from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { RemoteAccessConfig } from "@runweave/shared/tunnels";
import { isBetaChannel } from "../desktop/config.js";
import { remoteFreePort, startSsh, type SshProcess } from "./ssh-process.js";
import { logDesktopIncident } from "../desktop/diagnostics.js";

export class RemoteAccessVerificationError extends Error {
  constructor(
    readonly code: string,
    readonly phase: string,
    readonly transient: boolean,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

// Only user-facing Backend routes cross this boundary. Backend authentication is
// preserved; local internal/test routes must never become remotely accessible.
export class RemoteAccessChannel {
  readonly channelId = randomUUID();
  private server: http.Server | null = null;
  private sockets = new Set<Socket>();
  private ssh: SshProcess | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly probe = randomUUID();
  readonly address: string;
  constructor(
    private host: string,
    private config: RemoteAccessConfig,
    readonly backendUrl: string,
  ) {
    this.address = `http://${config.listenAddress}:${config.port}`;
  }
  private check() {
    if (this.stopped) throw new Error("TUNNEL_CANCELLED");
  }
  get alive() {
    return (
      !this.stopped &&
      !!this.ssh &&
      this.ssh.child.exitCode === null &&
      this.ssh.child.signalCode === null
    );
  }
  async start() {
    if (isBetaChannel) {
      throw new Error(
        "REMOTE_ACCESS_INSECURE_AUTH: Beta Backend 使用固定登录凭据，不能开放远程访问",
      );
    }
    const target = new URL(this.backendUrl);
    if (
      target.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    )
      throw new Error(
        "LOCAL_BACKEND_UNAVAILABLE: 本机服务尚未就绪，请检查运行状态",
      );
    const route = (req: http.IncomingMessage) => {
      try {
        const url = new URL(req.url ?? "/", "http://relay.invalid");
        const decoded = decodeURIComponent(url.pathname);
        const segments = decoded.split("/");
        if (
          decoded.includes("\\") ||
          decoded.includes("%") ||
          segments.length !== url.pathname.split("/").length ||
          segments.some(
            (segment) =>
              segment === "." ||
              segment === ".." ||
              [...segment].some(
                (character) =>
                  character.charCodeAt(0) < 32 ||
                  character.charCodeAt(0) === 127,
              ),
          )
        )
          return null;
        return url.pathname === "/health" ||
          url.pathname.startsWith("/api/") ||
          url.pathname.startsWith("/ws/")
          ? url.pathname + url.search
          : null;
      } catch {
        return null;
      }
    };
    const headers = (req: http.IncomingMessage): http.OutgoingHttpHeaders => {
      const result: http.OutgoingHttpHeaders = {
        ...req.headers,
        host: target.host,
      };
      for (const key of Object.keys(result))
        if (
          key.startsWith("x-forwarded-") ||
          [
            "forwarded",
            "via",
            "x-real-ip",
            "cf-connecting-ip",
            "cf-ray",
            "proxy-authorization",
            "proxy-connection",
          ].includes(key)
        )
          delete result[key];
      result["x-forwarded-for"] = "127.0.0.1";
      result["x-forwarded-proto"] = "http";
      return result;
    };
    const options = (req: http.IncomingMessage, path: string) => ({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path,
      headers: headers(req),
    });
    const server = http.createServer((req, res) => {
      if (
        req.url === `/runweave-relay-probe/${this.probe}` &&
        req.method === "GET"
      ) {
        res.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        });
        res.end(this.probe);
        return;
      }
      const path = route(req);
      if (!path) {
        res.writeHead(403);
        res.end();
        return;
      }
      const upstream = http.request(options(req, path), (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    this.server = server;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("upgrade", (req, socket, head) => {
      const path = route(req);
      if (
        !path ||
        !["/ws/terminal", "/ws/terminal-events", "/ws/browser-local"].includes(
          path.split("?")[0]!,
        )
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = http.request(options(req, path));
      upstream.on("upgrade", (reply, peer, upstreamHead) => {
        const connectedAt = Date.now();
        const id = (name: string) => {
          const value = req.headers[name];
          return typeof value === "string" &&
            /^[a-zA-Z0-9:_-]{1,160}$/.test(value)
            ? value
            : undefined;
        };
        const details = {
          channelId: this.channelId,
          path: path.split("?")[0],
          connectionId: id("x-connection-id"),
          attemptId: id("x-connection-attempt-id"),
        };
        logDesktopIncident({
          event: "remote-access.socket.connected",
          details,
        });
        socket.once("close", (hadError: boolean) =>
          logDesktopIncident({
            event: "remote-access.socket.closed",
            details: {
              ...details,
              hadError,
              durationMs: Date.now() - connectedAt,
            },
          }),
        );
        this.sockets.add(peer);
        peer.on("close", () => this.sockets.delete(peer));
        socket.write(
          `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${reply.rawHeaders.reduce((s, h, i) => s + (i % 2 ? `${h}\r\n` : `${h}: `), "")}\r\n`,
        );
        if (head.length) peer.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        socket.on("error", () => peer.destroy());
        peer.on("error", () => socket.destroy());
        socket.on("close", () => peer.destroy());
        peer.on("close", () => socket.destroy());
        socket.pipe(peer).pipe(socket);
      });
      upstream.on("response", (reply) => {
        socket.end(
          `HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        reply.resume();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.check();
    const local = server.address();
    if (!local || typeof local === "string")
      throw new Error("RELAY_START_FAILED");
    const remotePort = await remoteFreePort(this.host);
    this.check();
    // The remote process owns only its listener. An application heartbeat bounds
    // cleanup after hard network loss, without modifying the server's sshd.
    const command = reverseRelayCommand(this.config, remotePort);
    this.ssh = startSsh(
      this.host,
      ["-R", `127.0.0.1:${remotePort}:127.0.0.1:${local.port}`],
      command,
    );
    this.ssh.child.stdin.on("error", () => {});
    await this.ssh.ready;
    this.check();
    logDesktopIncident({
      event: "remote-access.channel.started",
      details: { channelId: this.channelId },
    });
    this.ssh.child.once("exit", (code, signal) =>
      logDesktopIncident({
        event: "remote-access.ssh.exited",
        details: {
          channelId: this.channelId,
          code,
          signal,
          intentional: this.stopped,
        },
      }),
    );
    this.heartbeat = setInterval(
      () => this.ssh?.child.stdin.write("ping\n"),
      10000,
    );
  }
  async verify() {
    this.check();
    if (!this.alive)
      throw new Error("RELAY_DISCONNECTED: 中转通道已断开，正在恢复");
    const fetchHealth = async (base: string) => {
      const response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(4000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("HEALTH_FAILED");
      return (await response.json()) as {
        status?: string;
        serviceInstanceId?: string;
      };
    };
    let phase = "local-health";
    try {
      const local = await fetchHealth(this.backendUrl);
      if (local.status !== "ok" || !local.serviceInstanceId)
        throw new RemoteAccessVerificationError(
          "LOCAL_BACKEND_UNAVAILABLE",
          phase,
          false,
          "本机服务身份无效",
        );
      phase = "relay-probe";
      const probe = await fetch(
        `${this.address}/runweave-relay-probe/${this.probe}`,
        { signal: AbortSignal.timeout(4000), redirect: "error" },
      );
      if (!probe.ok || (await probe.text()) !== this.probe)
        throw new RemoteAccessVerificationError(
          "RELAY_IDENTITY_MISMATCH",
          phase,
          false,
          "中转探针不匹配，已停止通道",
        );
      phase = "relay-health";
      const remote = await fetchHealth(this.address);
      if (
        remote.status !== "ok" ||
        remote.serviceInstanceId !== local.serviceInstanceId
      )
        throw new RemoteAccessVerificationError(
          "RELAY_IDENTITY_MISMATCH",
          phase,
          false,
          "中转服务身份不匹配，已停止通道",
        );
      return { serviceInstanceId: local.serviceInstanceId };
    } catch (error) {
      if (error instanceof RemoteAccessVerificationError) throw error;
      const timeout = error instanceof Error && error.name === "TimeoutError";
      throw new RemoteAccessVerificationError(
        timeout
          ? "REMOTE_ACCESS_PROBE_TIMEOUT"
          : phase === "local-health"
            ? "LOCAL_BACKEND_UNAVAILABLE"
            : "RELAY_UNREACHABLE",
        phase,
        timeout,
        timeout
          ? "健康探测超时，正在重新检查"
          : "连接探测失败，请检查服务与网络",
      );
    }
  }
  async stop() {
    if (!this.stopped)
      logDesktopIncident({
        event: "remote-access.channel.stopped",
        details: { channelId: this.channelId, sockets: this.sockets.size },
      });
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ssh?.child.stdin.end();
    await this.ssh?.stop();
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
