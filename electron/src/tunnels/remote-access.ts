import http from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { RemoteAccessConfig } from "@runweave/shared/tunnels";
import { remoteFreePort, startSsh, type SshProcess } from "./ssh-process.js";

// Only user-facing Backend routes cross this boundary. Backend authentication is
// preserved; local internal/test routes must never become remotely accessible.
export class RemoteAccessChannel {
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
  async start() {
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
        if (
          decoded.includes("\\") ||
          decoded.includes("%") ||
          decoded !== url.pathname
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
    const program = `
      const net = require("node:net");
      let last = Date.now();
      const sockets = new Set();
      const server = net.createServer(client => {
        const upstream = net.connect(${remotePort}, "127.0.0.1");
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        }
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      const stop = () => {
        for (const socket of sockets) socket.destroy();
        server.close();
        process.exit(0);
      };
      process.stdin.on("data", () => last = Date.now());
      process.stdin.on("end", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);
      setInterval(() => { if (Date.now() - last > 45000) stop(); }, 5000);
      server.on("error", error => { console.error(error.code); process.exit(1); });
      server.listen(${this.config.port}, ${JSON.stringify(this.config.listenAddress)},
        () => console.log("runweave-tunnel-ready"));
    `;
    const command = `node -e '${program.replace(/'/g, "'\\''")}'`;
    this.ssh = startSsh(
      this.host,
      ["-R", `127.0.0.1:${remotePort}:127.0.0.1:${local.port}`],
      command,
    );
    this.ssh.child.stdin.on("error", () => {});
    await this.ssh.ready;
    this.check();
    this.heartbeat = setInterval(
      () => this.ssh?.child.stdin.write("ping\n"),
      10000,
    );
  }
  async verify() {
    this.check();
    if (
      !this.ssh ||
      this.ssh.child.exitCode !== null ||
      this.ssh.child.signalCode !== null
    )
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
    let local;
    try {
      local = await fetchHealth(this.backendUrl);
      if (local.status !== "ok" || !local.serviceInstanceId) throw new Error();
    } catch {
      throw new Error(
        "LOCAL_BACKEND_UNAVAILABLE: 本机服务不可用，请检查运行状态",
      );
    }
    try {
      const probe = await fetch(
        `${this.address}/runweave-relay-probe/${this.probe}`,
        { signal: AbortSignal.timeout(4000), redirect: "error" },
      );
      if (!probe.ok || (await probe.text()) !== this.probe) throw new Error();
      const remote = await fetchHealth(this.address);
      if (
        remote.status !== "ok" ||
        remote.serviceInstanceId !== local.serviceInstanceId
      )
        throw new Error();
    } catch {
      throw new Error(
        "RELAY_UNREACHABLE: 中转入口不可达或指向不符，请检查服务器地址、端口、网络及 VPN",
      );
    }
  }
  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ssh?.child.stdin.end();
    await this.ssh?.stop();
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
