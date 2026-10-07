import type { RemoteDesktopRelayConfig, TunnelHostConfig, TunnelHostRuntime } from "@runweave/shared/tunnels";
import type { RunweaveElectronBridge } from "@runweave/shared/desktop-bridge";
import { Button } from "../../components/ui/button";
import { inputClass, labels } from "./presentation";

export function RemoteDesktopForm({ value, relayAddress, onChange }: {
  value?: RemoteDesktopRelayConfig;
  relayAddress?: string;
  onChange: (value: RemoteDesktopRelayConfig) => void;
}) {
  const config = value ?? { enabled: false, listenAddress: relayAddress ?? "", port: 15446,
    localAddress: "", localPort: 48571, certificateFingerprint: "" };
  return <fieldset className="space-y-3 border-t border-border pt-3">
    <legend className="font-medium">RemoteDesk · 可选</legend>
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={config.enabled} onChange={(e) => onChange({ ...config, enabled: e.target.checked })} />
      通过此主机远控本机 Mac
    </label>
    {config.enabled && <>
      <p className="text-xs text-muted-foreground">保持 Runweave 和 RemoteDesk 共享服务运行。手机需接入中转服务器所在网络或 VPN，配对与控制权限仍由 RemoteDesk 管理。</p>
      <label className="block">中转服务器内网 IPv4 地址
        <input required className={inputClass} value={config.listenAddress} onChange={(e) => onChange({ ...config, listenAddress: e.target.value.trim() })} />
      </label>
      <label className="block">手机远控端口
        <input required type="number" min={1024} max={65535} className={inputClass} value={config.port || ""} onChange={(e) => onChange({ ...config, port: Number(e.target.value) })} />
      </label>
      <p className="text-xs text-muted-foreground">使用独立端口，不与 Runweave 远程访问共用。服务器需可通过 SSH 执行 Node.js 并允许端口转发。</p>
      <label className="block">本机 RemoteDesk 地址
        <input required className={inputClass} placeholder="RemoteDesk 窗口中的局域网 IPv4" value={config.localAddress} onChange={(e) => onChange({ ...config, localAddress: e.target.value.trim() })} />
      </label>
      <label className="block">本机 RemoteDesk 端口
        <input required type="number" min={1} max={65535} className={inputClass} value={config.localPort || ""} onChange={(e) => onChange({ ...config, localPort: Number(e.target.value) })} />
      </label>
      <label className="block">RemoteDesk 证书 SHA-256 指纹
        <input required className={inputClass} placeholder="复制 Mac 显示的完整指纹" value={config.certificateFingerprint}
          onChange={(e) => onChange({ ...config, certificateFingerprint: e.target.value.replace(/[:\s]/g, "").toLowerCase() })} />
      </label>
    </>}
  </fieldset>;
}

export function RemoteDesktopStatus({ host, runtime, busy, run }: {
  host: TunnelHostConfig;
  runtime?: TunnelHostRuntime;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const config = host.remoteDesktop;
  const status = runtime?.remoteDesktop;
  const ready = runtime?.state === "ready" && status?.state === "ready";
  return <div className="space-y-2 border-t border-border pt-3" data-remote-desktop-state={status?.state ?? "disabled"}>
    <h4 className="text-sm font-medium">RemoteDesk</h4>
    {!config?.enabled ? <p className="text-xs text-muted-foreground">未启用 · 编辑主机可配置手机远控中转。</p> : <>
      <p className="text-sm">{ready ? "中转入口与 Host 证书已验证" : runtime?.state === "disconnected" ? "主机已断开" : labels[status?.state ?? "waiting"]}</p>
      {(runtime?.error || status?.error) && <p role="alert" className="text-sm text-amber-600">{runtime?.error?.message ?? status?.error?.message}</p>}
      <p className="break-all text-sm">{config.listenAddress}:{config.port}</p>
      <p className="text-xs text-muted-foreground">先在局域网完成 Mac 配对，再在手机「Mac 桌面 → 编辑地址」启用 Runweave 隧道并填写此地址与端口。首次画面和控制需在手机确认。</p>
      {status?.checkedAt && <p className="text-xs text-muted-foreground">最近检查：{new Date(status.checkedAt).toLocaleTimeString()}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!ready || busy} onClick={() => void run(() => navigator.clipboard.writeText(status!.address!))}>复制远控地址</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => (window.electronAPI as RunweaveElectronBridge).retryTunnel(host.id, "remote-desktop"))}>重新检测</Button>
      </div>
    </>}
  </div>;
}
