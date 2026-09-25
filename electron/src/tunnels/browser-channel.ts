import type { TunnelHostConfig } from "@runweave/shared/tunnels";
import type {
  DesktopBrowserBinding,
  RemoteCapabilities,
} from "@runweave/shared/remote";
import { desktopRuntime } from "../desktop/runtime-state.js";
import {
  createRemoteBrowserGateway,
  type RemoteBrowserGateway,
} from "../remote/browser-gateway.js";
import { remoteFreePort, startSsh, type SshProcess } from "./ssh-process.js";
import type { TunnelCredentials } from "./credentials.js";

export class BrowserChannel {
  private gateway: RemoteBrowserGateway | null = null;
  private reverse: SshProcess | null = null;
  private binding: DesktopBrowserBinding | null = null;
  private token: string | null = null;
  private stopped = false;
  private port = 0;
  private busy = false;
  installationId: string | null = null;
  constructor(
    private readonly desktopId: string,
    private readonly host: TunnelHostConfig,
    private readonly generation: number,
    private readonly base: string,
    private readonly credentials: TunnelCredentials,
  ) {}
  private check() {
    if (this.stopped) throw new Error("TUNNEL_CANCELLED");
  }
  async refresh(): Promise<DesktopBrowserBinding> {
    if (this.busy) {
      if (this.binding) return this.binding;
      throw new Error("BROWSER_STARTING");
    }
    this.busy = true;
    try {
      this.check();
      this.token = await this.credentials.token(
        this.host.id,
        `${this.host.sshTarget}:${this.host.browser.backendPort}`,
        this.base,
      );
      this.check();
      const caps = await fetch(`${this.base}/api/remote/capabilities`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (caps.status === 401) {
        this.credentials.invalidateAccess(this.host.id);
        throw new Error("NEEDS_AUTH: 请重新登录远端 Runweave");
      }
      if (!caps.ok) throw new Error("BACKEND_UNAVAILABLE: 远端 Backend 不可用");
      const info = (await caps.json()) as RemoteCapabilities;
      if (info.protocolVersion !== 2)
        throw new Error(
          "REMOTE_CAPABILITY_UNSUPPORTED: 请更新远端 Backend 以使用独立浏览器通道",
        );
      if (
        typeof info.installationId !== "string" ||
        !info.capabilities?.desktopBrowser
      )
        throw new Error(
          "REMOTE_CAPABILITY_UNSUPPORTED: 远端不支持 Browser 回连",
        );
      this.credentials.verifyInstallation(this.host.id, info.installationId);
      this.installationId = info.installationId;
      this.check();
      if (!this.gateway) {
        const cdpEndpoint = desktopRuntime.cdpProxy?.endpoint;
        if (!cdpEndpoint)
          throw new Error("DESKTOP_UNAVAILABLE: 本机 Browser 尚未就绪");
        this.gateway = await createRemoteBrowserGateway({
          desktopId: this.desktopId,
          hostId: this.host.id,
          generation: this.generation,
          allowedProfileId: this.host.browser.profileId,
          approvedBrowserGroupId: this.host.browser.approvedBrowserGroupId,
          cdpEndpoint,
        });
        this.check();
        this.port = await remoteFreePort(this.host.sshTarget);
        this.check();
        this.reverse = startSsh(this.host.sshTarget, [
          "-R",
          `127.0.0.1:${this.port}:127.0.0.1:${this.gateway.port}`,
        ]);
        await this.reverse.ready;
        this.check();
      }
      if (
        this.reverse?.child.exitCode !== null ||
        this.reverse?.child.signalCode !== null
      )
        throw new Error("BROWSER_DISCONNECTED: 浏览器通道中断");
      const response = await fetch(
        `${this.base}/api/desktop-browser/bindings`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({
            protocolVersion: 2,
            desktopId: this.desktopId,
            hostId: this.host.id,
            generation: this.generation,
            reversePort: this.port,
            gatewayKey: this.gateway.key,
          }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "NEEDS_AUTH: 远端登录已过期"
            : "BROWSER_BINDING_FAILED: 无法注册浏览器通道，请检查远端版本",
        );
      const binding = (await response.json()) as DesktopBrowserBinding;
      if (
        binding.protocolVersion !== 2 ||
        binding.desktopId !== this.desktopId ||
        binding.hostId !== this.host.id
      )
        throw new Error("REMOTE_CAPABILITY_UNSUPPORTED: 请更新远端 Backend");
      this.binding = binding;
      this.check();
      return binding;
    } finally {
      this.busy = false;
      if (this.stopped) await this.stop();
    }
  }
  async select(terminalSessionId: string): Promise<void> {
    if (!this.binding || !this.token) throw new Error("DESKTOP_UNAVAILABLE");
    const res = await fetch(
      `${this.base}/api/terminal/session/${encodeURIComponent(terminalSessionId)}/browser/binding`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ bindingId: this.binding.id }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!res.ok)
      throw new Error(
        res.status === 409
          ? "BROWSER_BINDING_CONFLICT: 此终端正在使用另一台桌面"
          : "BROWSER_BINDING_FAILED",
      );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const binding = this.binding;
    this.binding = null;
    if (binding && this.token)
      await fetch(
        `${this.base}/api/desktop-browser/bindings/${encodeURIComponent(binding.id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(1000),
          redirect: "error",
        },
      ).catch(() => {});
    await this.reverse?.stop();
    this.reverse = null;
    await this.gateway?.close();
    this.gateway = null;
  }
}
