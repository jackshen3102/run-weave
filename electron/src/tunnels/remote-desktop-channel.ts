import tls from "node:tls";
import { networkInterfaces } from "node:os";
import { X509Certificate } from "node:crypto";
import type { RemoteDesktopRelayConfig } from "@runweave/shared/tunnels";
import { remoteFreePort, startSsh, type SshProcess } from "./ssh-process.js";
import { reverseRelayCommand } from "./reverse-relay-command.js";

/** Relays opaque TLS bytes. RemoteDesk retains pairing, authorization and media ownership. */
export class RemoteDesktopChannel {
  private ssh: SshProcess | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  private probes = new Set<tls.TLSSocket>();
  readonly address: string;
  constructor(private host: string, private config: RemoteDesktopRelayConfig) {
    this.address = `${config.listenAddress}:${config.port}`;
  }
  get alive() {
    return !this.stopped && !!this.ssh && this.ssh.child.exitCode === null && this.ssh.child.signalCode === null;
  }
  private check() { if (this.stopped) throw new Error("TUNNEL_CANCELLED"); }
  private checkLocalAddress() {
    const local = Object.values(networkInterfaces()).flat().some((entry) =>
      entry?.family === "IPv4" && !entry.internal && entry.address === this.config.localAddress);
    if (!local) throw new Error("REMOTE_DESKTOP_ADDRESS_CHANGED: RemoteDesk 地址不属于当前 Mac，请核对 Host 显示的地址");
  }
  async start() {
    this.check();
    this.checkLocalAddress();
    await this.probe(this.config.localAddress, this.config.localPort);
    this.check();
    const port = await remoteFreePort(this.host);
    this.check();
    // Local destination is restricted to this Mac; there is no arbitrary LAN proxy.
    this.ssh = startSsh(this.host,
      ["-R", `127.0.0.1:${port}:${this.config.localAddress}:${this.config.localPort}`],
      reverseRelayCommand(this.config, port, 8));
    this.ssh.child.stdin.on("error", () => {});
    await this.ssh.ready;
    this.check();
    this.heartbeat = setInterval(() => this.ssh?.child.stdin.write("ping\n"), 10_000);
  }
  async verify() {
    this.check();
    this.checkLocalAddress();
    if (!this.alive) throw new Error("RELAY_DISCONNECTED: RemoteDesk 中转已断开，正在恢复");
    await this.probe(this.config.listenAddress, this.config.port);
    this.check();
  }
  private probe(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // The exact pinned self-signed Host certificate is the trust anchor. This
      // probe sends no credentials or application data and never starts capture.
      const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
      this.probes.add(socket);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.probes.delete(socket);
        socket.destroy();
        if (error) reject(error); else resolve();
      };
      socket.setTimeout(4_000, () => finish(new Error("REMOTE_DESKTOP_TIMEOUT: RemoteDesk 连接检查超时")));
      socket.once("error", () => finish(new Error("REMOTE_DESKTOP_UNAVAILABLE: 无法连接 RemoteDesk，请检查共享服务与网络")));
      socket.once("close", () => finish(new Error("REMOTE_DESKTOP_CLOSED: RemoteDesk 检查连接已关闭")));
      socket.once("secureConnect", () => {
        try {
          const raw = socket.getPeerCertificate().raw;
          if (!raw) throw new Error("missing certificate");
          const certificate = new X509Certificate(raw);
          const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
          const now = Date.now();
          if (fingerprint !== this.config.certificateFingerprint ||
            !(Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo)) ||
            !certificate.verify(certificate.publicKey)) throw new Error("invalid certificate");
          finish();
        } catch { finish(new Error("REMOTE_DESKTOP_IDENTITY_MISMATCH: RemoteDesk 证书与已配置指纹不符或已失效")); }
      });
    });
  }
  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const probe of this.probes) probe.destroy();
    this.probes.clear();
    this.ssh?.child.stdin.end();
    await this.ssh?.stop();
  }
}
