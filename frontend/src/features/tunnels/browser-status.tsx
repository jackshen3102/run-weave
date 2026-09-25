import type { RunweaveElectronBridge } from "@runweave/shared/desktop-bridge";
import { useState } from "react";
import type {
  TunnelHostConfig,
  TunnelHostRuntime,
} from "@runweave/shared/tunnels";
import { Button } from "../../components/ui/button";
import { inputClass, labels } from "./presentation";
export function BrowserStatus({
  host,
  runtime,
  run,
  busy,
}: {
  host: TunnelHostConfig;
  runtime: TunnelHostRuntime | undefined;
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-2 border-t border-border pt-3 text-sm">
      <div className="flex justify-between">
        <h4 className="font-medium">远端使用本机 Browser</h4>
        <span>
          {
            labels[
              runtime?.browser.state ??
                (host.browser.enabled ? "waiting" : "disabled")
            ]
          }
        </span>
      </div>
      {host.browser.enabled && (
        <>
          <p className="text-xs text-muted-foreground">
            Browser {host.browser.profileId.slice(-1)} · 远端 Backend{" "}
            {host.browser.backendPort}
          </p>
          {runtime?.browser.error && (
            <p role="alert" className="text-amber-600">
              {runtime.browser.error.message}
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || runtime?.state !== "ready"}
            onClick={() => setLoginOpen(!loginOpen)}
          >
            登录远端 Backend
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || runtime?.state !== "ready"}
            onClick={() =>
              void run(() =>
                (window.electronAPI as RunweaveElectronBridge).retryTunnel(
                  host.id,
                ),
              )
            }
          >
            重试浏览器通道
          </Button>
          {(loginOpen || runtime?.browser.state === "needs_auth") && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  try {
                    const result = await (
                      window.electronAPI as RunweaveElectronBridge
                    ).loginTunnelBrowser({
                      hostId: host.id,
                      username,
                      password,
                    });
                    setMessage(
                      result.persistent
                        ? "登录已加密保存"
                        : "系统加密不可用，登录仅在本次运行有效",
                    );
                    setLoginOpen(false);
                  } finally {
                    setPassword("");
                  }
                });
              }}
            >
              <label className="block">
                用户名
                <input
                  autoComplete="username"
                  className={inputClass}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label className="block">
                密码
                <input
                  type="password"
                  autoComplete="current-password"
                  className={inputClass}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                type="submit"
                disabled={busy || runtime?.state !== "ready"}
              >
                登录并启用
              </Button>
            </form>
          )}
          {message && <p role="status">{message}</p>}
        </>
      )}
    </div>
  );
}
