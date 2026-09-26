import type {
  RemoteAccessConfig,
  TunnelHostConfig,
  TunnelHostRuntime,
} from "@runweave/shared/tunnels";
import type { RunweaveElectronBridge } from "@runweave/shared/desktop-bridge";
import { Button } from "../../components/ui/button";
import { inputClass, labels } from "./presentation";

export function RemoteAccessForm({
  value,
  onChange,
}: {
  value?: RemoteAccessConfig;
  onChange: (value: RemoteAccessConfig) => void;
}) {
  const config = value ?? { enabled: false, listenAddress: "", port: 15443 };
  return (
    <fieldset className="space-y-3 border-t border-border pt-3">
      <legend className="font-medium">远程访问本机 · 可选</legend>
      <p className="text-xs text-muted-foreground">
        手机通过你的中转服务器访问这台 Mac，代码和 Agent
        仍在本机运行。关闭时不建立此通道。
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
        />
        启用远程访问本机
      </label>
      {config.enabled && (
        <>
          <label className="block">
            中转服务器内网 IPv4 地址
            <input
              required
              className={inputClass}
              placeholder="例如 192.168.1.10"
              value={config.listenAddress}
              onChange={(e) =>
                onChange({ ...config, listenAddress: e.target.value.trim() })
              }
            />
          </label>
          <label className="block">
            手机访问端口
            <input
              required
              className={inputClass}
              type="number"
              min={1024}
              max={65535}
              value={config.port || ""}
              onChange={(e) =>
                onChange({ ...config, port: Number(e.target.value) })
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            服务器需已安装 Node.js，SSH 可执行 node，且允许端口转发。Mac
            和手机均需能访问此内网地址，必要时连接
            VPN。保存后连接主机，桌面端会启动中转并检查入口。
          </p>
          <p className="text-xs text-muted-foreground">
            重启后需先登录 Mac、启动 Runweave，并恢复网络和 SSH
            认证；可勾选上方“启动桌面端时自动连接”。
          </p>
        </>
      )}
    </fieldset>
  );
}

export function RemoteAccessStatus({
  host,
  runtime,
  busy,
  run,
}: {
  host: TunnelHostConfig;
  runtime?: TunnelHostRuntime;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const config = host.remoteAccess;
  const status = runtime?.remoteAccess;
  const ready =
    config?.enabled && runtime?.state === "ready" && status?.state === "ready";
  return (
    <div
      className="space-y-2 border-t border-border pt-3"
      data-remote-access-state={status?.state ?? "disabled"}
    >
      <h4 className="text-sm font-medium">远程访问本机</h4>
      {!config?.enabled ? (
        <p className="text-xs text-muted-foreground">
          未启用 · 编辑主机可配置手机经中转访问这台电脑。
        </p>
      ) : (
        <>
          <p className="text-sm">
            {ready
              ? "中转入口可用"
              : runtime?.state === "disconnected"
                ? "主机已断开"
                : labels[status?.state ?? "waiting"]}
          </p>
          {(runtime?.error || status?.error) && (
            <p role="alert" className="text-sm text-amber-600">
              {runtime?.error?.message ?? status?.error?.message}
            </p>
          )}
          <p className="break-all text-sm">
            http://{config.listenAddress}:{config.port}
          </p>
          <p className="text-xs text-muted-foreground">
            手机接入相同网络或 VPN 后，在连接管理中添加此地址，使用这台 Mac 的
            Runweave 账号登录。
          </p>
          {status?.checkedAt && (
            <p className="text-xs text-muted-foreground">
              最近检查：{new Date(status.checkedAt).toLocaleTimeString()}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!ready || busy}
              onClick={() =>
                void run(() => navigator.clipboard.writeText(status!.address!))
              }
            >
              复制连接地址
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  (window.electronAPI as RunweaveElectronBridge).retryTunnel(
                    host.id,
                    "remote-access",
                  ),
                )
              }
            >
              重新检测
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
