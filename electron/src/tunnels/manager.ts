import { BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  TunnelConfigUpdate,
  TunnelHostConfig,
  TunnelHostRuntime,
  TunnelSnapshot,
  TunnelState,
} from "@runweave/shared/tunnels";
import {
  desktopStateOwner,
  desktopStateRoot,
  writePrivateJson,
} from "../desktop/local-state.js";
import { desktopProxySummaries } from "../browser/profile/network-summary.js";
import { startSsh, freePort, type SshProcess } from "./ssh-process.js";
import { TunnelStore } from "./store.js";
import { TunnelCredentials } from "./credentials.js";
import { BrowserChannel } from "./browser-channel.js";

interface Host {
  config: TunnelHostConfig;
  runtime: TunnelHostRuntime;
  desired: boolean;
  control: SshProcess | null;
  forwards: Map<string, SshProcess>;
  backends: Map<number, { process: SshProcess; url: string }>;
  channel: BrowserChannel | null;
  browserBusy: boolean;
  browserEpoch: number;
  endpointPending: Map<number, Promise<string>>;
  lastBrowserRefresh: number;
  busy: boolean;
  retryAt: number;
  failures: number;
}
const childState = (
  state: TunnelState["state"],
  error: TunnelState["error"] = null,
): TunnelState => ({ state, error });
function failure(error: unknown): NonNullable<TunnelState["error"]> {
  const text = error instanceof Error ? error.message : "TUNNEL_FAILED";
  const code = /^[A-Z_]+/.exec(text)?.[0] ?? "TUNNEL_FAILED";
  return {
    code,
    message: text.includes(": ")
      ? text.slice(text.indexOf(": ") + 2)
      : "通道不可用，请检查 SSH 配置和远端服务",
  };
}
export class TunnelManager {
  readonly store = new TunnelStore();
  readonly credentials = new TunnelCredentials();
  private readonly instanceId = randomUUID();
  private hosts = new Map<string, Host>();
  private timer: NodeJS.Timeout | null = null;
  private online = true;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private appliedRevision = this.store.read().revision;
  private channelGeneration = Date.now();
  private publishedError: string | null = null;
  constructor() {
    for (const config of this.store.read().hosts)
      this.hosts.set(config.id, this.create(config));
  }
  private create(config: TunnelHostConfig): Host {
    return {
      config,
      desired: false,
      control: null,
      forwards: new Map(),
      backends: new Map(),
      channel: null,
      browserBusy: false,
      browserEpoch: 0,
      endpointPending: new Map(),
      lastBrowserRefresh: 0,
      busy: false,
      retryAt: 0,
      failures: 0,
      runtime: {
        hostId: config.id,
        generation: Date.now(),
        state: "disconnected",
        error: null,
        forwards: Object.fromEntries(
          config.forwards.map((f) => [
            f.id,
            childState(f.enabled ? "waiting" : "disabled"),
          ]),
        ),
        browser: childState(config.browser.enabled ? "waiting" : "disabled"),
        installationId: null,
        bindingId: null,
        endpoints: {},
      },
    };
  }
  snapshot(): TunnelSnapshot {
    const config = this.store.read();
    return structuredClone({
      schemaVersion: 1,
      config,
      owner: desktopStateOwner(config.desktopId),
      executorInstanceId: this.instanceId,
      executor: this.online ? "online" : "offline",
      observedAt: Date.now(),
      appliedRevision: this.appliedRevision,
      hosts: [...this.hosts.values()].map((h) => h.runtime),
    });
  }
  private publish() {
    const snapshot = this.snapshot();
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send("tunnels:changed", snapshot);
    try {
      writePrivateJson(
        path.join(desktopStateRoot(), "tunnels", "runtime.json"),
        snapshot,
      );
      writePrivateJson(path.join(desktopStateRoot(), "desktop-network.json"), {
        tunnels: snapshot,
        proxyProfiles: desktopProxySummaries(),
      });
      this.publishedError = null;
    } catch {
      if (!this.publishedError) {
        this.publishedError = "运行状态无法保存";
        this.notify("隧道状态文件无法写入，请检查用户目录");
      }
    }
  }
  private notify(message: string) {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send("tunnels:notice", message);
    if (
      !BrowserWindow.getAllWindows().some((w) => w.isFocused()) &&
      Notification.isSupported()
    ) {
      const notice = new Notification({ title: "端口与隧道", body: message });
      notice.on("click", () => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.show();
        win?.webContents.send("tunnels:open");
      });
      notice.show();
    }
  }
  start() {
    this.timer = setInterval(() => {
      for (const h of this.hosts.values()) {
        if (
          h.desired &&
          !h.busy &&
          h.runtime.state !== "ready" &&
          h.retryAt > 0 &&
          Date.now() >= h.retryAt
        )
          void this.connect(h.config.id);
        if (h.desired && h.runtime.state === "ready") {
          void this.browser(h);
          void this.restoreEndpoints(h);
        }
      }
      this.publish();
    }, 5000);
    for (const h of this.hosts.values())
      if (h.config.autoConnect) void this.connect(h.config.id);
    this.publish();
  }
  private current(h: Host, generation: number) {
    return (
      this.online &&
      h.desired &&
      h.runtime.generation === generation &&
      this.hosts.get(h.config.id) === h
    );
  }
  async connect(id: string): Promise<void> {
    const h = this.hosts.get(id);
    if (!h) throw new Error("TUNNEL_NOT_FOUND");
    if (h.busy || h.runtime.state === "ready") return;
    h.desired = true;
    h.busy = true;
    h.retryAt = 0;
    const generation = ++h.runtime.generation;
    h.runtime.state = h.failures ? "reconnecting" : "connecting";
    h.runtime.error = null;
    this.publish();
    const process = startSsh(h.config.sshTarget);
    h.control = process;
    try {
      await process.ready;
      if (!this.current(h, generation)) return;
      h.runtime.state = "ready";
      h.failures = 0;
      process.child.once("exit", () => {
        if (this.current(h, generation)) void this.connectionLost(h);
      });
      await this.applyChildren(h);
      this.publish();
    } catch (error) {
      if (this.current(h, generation)) {
        h.runtime.state = "failed";
        h.runtime.error = failure(error);
        this.schedule(h);
        this.publish();
      }
    } finally {
      h.busy = false;
      if (!this.current(h, generation)) await process.stop();
    }
  }
  private schedule(h: Host) {
    if (h.runtime.error?.code === "SSH_AUTH_FAILED") {
      h.retryAt = 0;
      return;
    }
    const delays = [1000, 2000, 5000, 10000, 30000];
    h.retryAt = Date.now() + delays[Math.min(h.failures++, delays.length - 1)]!;
  }
  private async connectionLost(h: Host) {
    await this.stopResources(h);
    if (!h.desired) return;
    h.runtime.state = "reconnecting";
    h.runtime.error = {
      code: "SSH_DISCONNECTED",
      message: "SSH 连接中断，正在重连",
    };
    this.schedule(h);
    this.notify(`${h.config.name} 连接中断`);
    this.publish();
  }
  private async stopBrowser(h: Host) {
    ++h.browserEpoch;
    const channel = h.channel;
    h.channel = null;
    h.lastBrowserRefresh = 0;
    h.runtime.bindingId = null;
    h.runtime.browser = childState(
      h.config.browser.enabled ? "waiting" : "disabled",
    );
    await channel?.stop();
  }
  private async stopResources(h: Host) {
    ++h.runtime.generation;
    const control = h.control;
    h.control = null;
    const jobs = [
      ...h.forwards.values(),
      ...[...h.backends.values()].map((x) => x.process),
    ];
    h.forwards.clear();
    h.backends.clear();
    h.runtime.endpoints = {};
    for (const f of h.config.forwards)
      h.runtime.forwards[f.id] = childState(f.enabled ? "waiting" : "disabled");
    await Promise.all([
      control?.stop(),
      ...jobs.map((p) => p.stop()),
      this.stopBrowser(h),
    ]);
  }
  async disconnect(id: string) {
    const h = this.hosts.get(id);
    if (!h) return;
    h.desired = false;
    h.retryAt = 0;
    await this.stopResources(h);
    h.runtime.state = "disconnected";
    h.runtime.error = null;
    this.publish();
  }
  private async forward(h: Host, id: string) {
    const f = h.config.forwards.find((f) => f.id === id);
    if (!f || !f.enabled || h.forwards.has(id)) return;
    const generation = h.runtime.generation;
    h.runtime.forwards[id] = childState("starting");
    this.publish();
    const process = startSsh(h.config.sshTarget, [
      "-L",
      `127.0.0.1:${f.port}:127.0.0.1:${f.port}`,
    ]);
    h.forwards.set(id, process);
    const active = () =>
      this.current(h, generation) && h.forwards.get(id) === process;
    try {
      await process.ready;
      if (!active()) {
        await process.stop();
        return;
      }
      h.runtime.forwards[id] = childState("ready");
      process.child.once("exit", () => {
        if (active()) {
          h.forwards.delete(id);
          h.runtime.forwards[id] = childState("failed", {
            code: "FORWARD_DISCONNECTED",
            message: "端口转发已中断，请重试",
          });
          this.notify(`${h.config.name} 的端口 ${f.port} 转发中断`);
          this.publish();
        }
      });
    } catch (error) {
      if (active()) {
        h.forwards.delete(id);
        h.runtime.forwards[id] = childState("failed", failure(error));
      }
    }
    this.publish();
  }
  private endpoint(h: Host, port: number): Promise<string> {
    const pending = h.endpointPending.get(port);
    if (pending) return pending;
    const result = this.createEndpoint(h, port).finally(() => {
      if (h.endpointPending.get(port) === result)
        h.endpointPending.delete(port);
    });
    h.endpointPending.set(port, result);
    return result;
  }
  private async createEndpoint(h: Host, port: number): Promise<string> {
    const previous = h.backends.get(port);
    if (previous) {
      await previous.process.ready;
      return previous.url;
    }
    const generation = h.runtime.generation;
    const localPort = await freePort();
    if (!this.current(h, generation)) throw new Error("TUNNEL_CANCELLED");
    const process = startSsh(h.config.sshTarget, [
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${port}`,
    ]);
    const entry = { process, url: `http://127.0.0.1:${localPort}` };
    h.backends.set(port, entry);
    try {
      await process.ready;
      if (!this.current(h, generation)) {
        await process.stop();
        throw new Error("TUNNEL_CANCELLED");
      }
      process.child.once("exit", () => {
        if (h.backends.get(port) === entry) {
          h.backends.delete(port);
          for (const e of this.store
            .read()
            .backendEndpoints.filter(
              (e) => e.hostId === h.config.id && e.remotePort === port,
            ))
            delete h.runtime.endpoints[e.id];
          void this.stopBrowser(h).then(() => this.publish());
        }
      });
      return entry.url;
    } catch (error) {
      if (h.backends.get(port) === entry) h.backends.delete(port);
      throw error;
    }
  }
  private async browser(h: Host) {
    if (
      !h.config.browser.enabled ||
      h.browserBusy ||
      Date.now() - h.lastBrowserRefresh < 20000
    )
      return;
    h.browserBusy = true;
    const epoch = h.browserEpoch;
    const generation = h.runtime.generation;
    h.lastBrowserRefresh = Date.now();
    try {
      if (h.runtime.browser.state !== "ready")
        h.runtime.browser = childState("starting");
      this.publish();
      const base = await this.endpoint(h, h.config.browser.backendPort);
      if (!this.current(h, generation) || h.browserEpoch !== epoch) return;
      const channel =
        h.channel ??
        new BrowserChannel(
          this.store.read().desktopId,
          h.config,
          ++this.channelGeneration,
          base,
          this.credentials,
        );
      h.channel = channel;
      const binding = await channel.refresh();
      if (
        !this.current(h, generation) ||
        h.browserEpoch !== epoch ||
        h.channel !== channel
      ) {
        await channel.stop();
        return;
      }
      h.runtime.bindingId = binding.id;
      h.runtime.installationId = channel.installationId;
      h.runtime.browser = childState("ready");
    } catch (error) {
      if (this.current(h, generation) && h.browserEpoch === epoch) {
        const fail = failure(error);
        await this.stopBrowser(h);
        h.lastBrowserRefresh = Date.now();
        h.runtime.browser = childState(
          fail.code === "NEEDS_AUTH" ? "needs_auth" : "failed",
          fail,
        );
      }
    } finally {
      h.browserBusy = false;
      this.publish();
    }
  }
  private async applyChildren(h: Host) {
    await Promise.all(
      h.config.forwards.map(async (f) => {
        if (f.enabled) await this.forward(h, f.id);
        else h.runtime.forwards[f.id] = childState("disabled");
      }),
    );
    for (const e of this.store
      .read()
      .backendEndpoints.filter((e) => e.hostId === h.config.id)) {
      try {
        h.runtime.endpoints[e.id] = await this.endpoint(h, e.remotePort);
      } catch {
        delete h.runtime.endpoints[e.id];
      }
    }
    void this.browser(h);
  }
  private async restoreEndpoints(h: Host) {
    const generation = h.runtime.generation;
    for (const e of this.store
      .read()
      .backendEndpoints.filter((e) => e.hostId === h.config.id)) {
      if (h.runtime.endpoints[e.id]) continue;
      try {
        const url = await this.endpoint(h, e.remotePort);
        if (
          this.current(h, generation) &&
          this.store
            .read()
            .backendEndpoints.some(
              (current) =>
                current.id === e.id && current.remotePort === e.remotePort,
            )
        )
          h.runtime.endpoints[e.id] = url;
      } catch {
        /* Next heartbeat retries only this endpoint. */
      }
    }
  }
  save(
    input: TunnelConfigUpdate,
    migrationId?: string,
  ): Promise<TunnelSnapshot> {
    const run = this.saveQueue.then(async () => {
      const config = this.store.save(input, migrationId);
      for (const id of this.hosts.keys())
        if (!config.hosts.some((c) => c.id === id)) {
          await this.disconnect(id);
          this.hosts.delete(id);
          this.credentials.forget(id);
        }
      for (const next of config.hosts) {
        let h = this.hosts.get(next.id);
        if (!h) {
          h = this.create(next);
          this.hosts.set(next.id, h);
          if (migrationId && next.autoConnect) void this.connect(next.id);
          continue;
        }
        if (h.config.sshTarget !== next.sshTarget) {
          await this.disconnect(next.id);
          this.credentials.forget(next.id);
        }
        for (const [id, process] of h.forwards) {
          const old = h.config.forwards.find((f) => f.id === id);
          const fresh = next.forwards.find((f) => f.id === id);
          if (!fresh?.enabled || old?.port !== fresh.port) {
            h.forwards.delete(id);
            await process.stop();
            delete h.runtime.forwards[id];
          }
        }
        const browserChanged =
          JSON.stringify(h.config.browser) !== JSON.stringify(next.browser);
        h.config = next;
        if (browserChanged) await this.stopBrowser(h);
        const required = new Set(
          config.backendEndpoints
            .filter((e) => e.hostId === next.id)
            .map((e) => e.remotePort),
        );
        if (next.browser.enabled) required.add(next.browser.backendPort);
        for (const [port, entry] of h.backends)
          if (!required.has(port)) {
            h.backends.delete(port);
            await entry.process.stop();
          }
        for (const id of Object.keys(h.runtime.endpoints))
          if (
            !config.backendEndpoints.some(
              (e) => e.id === id && e.hostId === next.id,
            )
          )
            delete h.runtime.endpoints[id];
        for (const f of next.forwards)
          if (!f.enabled || !h.runtime.forwards[f.id])
            h.runtime.forwards[f.id] = childState(
              f.enabled ? "waiting" : "disabled",
            );
        for (const id of Object.keys(h.runtime.forwards))
          if (!next.forwards.some((f) => f.id === id))
            delete h.runtime.forwards[id];
        if (h.runtime.state === "ready") await this.applyChildren(h);
      }
      this.appliedRevision = config.revision;
      this.publish();
      return this.snapshot();
    });
    this.saveQueue = run.catch(() => {});
    return run;
  }
  async login(id: string, username: string, password: string) {
    const h = this.hosts.get(id);
    if (!h || h.runtime.state !== "ready") throw new Error("请先连接 SSH 主机");
    const base = await this.endpoint(h, h.config.browser.backendPort);
    await this.credentials.login(
      id,
      `${h.config.sshTarget}:${h.config.browser.backendPort}`,
      base,
      username,
      password,
    );
    await this.stopBrowser(h);
    await this.browser(h);
    return { persistent: this.credentials.isPersistent() };
  }
  async selectBrowser(id: string, terminalId: string) {
    const h = this.hosts.get(id);
    if (!h?.channel) throw new Error("DESKTOP_UNAVAILABLE");
    await h.channel.select(terminalId);
  }
  async retry(id: string, forwardId?: string) {
    const h = this.hosts.get(id);
    if (!h) throw new Error("TUNNEL_NOT_FOUND");
    if (h.runtime.state !== "ready") return this.connect(id);
    if (forwardId) await this.forward(h, forwardId);
    else {
      await this.stopBrowser(h);
      await this.browser(h);
    }
  }
  async stop() {
    this.online = false;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.hosts.keys()].map((id) => this.disconnect(id)));
    this.publish();
  }
}
