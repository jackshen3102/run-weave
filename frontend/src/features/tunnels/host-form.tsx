import type { RunweaveElectronBridge } from "@runweave/shared/desktop-bridge";
import { useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  TunnelHostConfig,
  TunnelSnapshot,
} from "@runweave/shared/tunnels";
import { validateTunnelUpdate } from "@runweave/shared/tunnels";
import { Button } from "../../components/ui/button";
import { inputClass } from "./presentation";
export function HostForm({
  host,
  snapshot,
  onCancel,
  onSaved,
}: {
  host: TunnelHostConfig;
  snapshot: TunnelSnapshot;
  onCancel: () => void;
  onSaved: (next: TunnelSnapshot) => void;
}) {
  const [draft, setDraft] = useState(host);
  const [revision] = useState(snapshot.config.revision);
  const [endpoints, setEndpoints] = useState(
    snapshot.config.backendEndpoints.filter((e) => e.hostId === host.id),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (value: Partial<TunnelHostConfig>) =>
    setDraft({ ...draft, ...value });
  const save = useMemoizedFn(async () => {
    setError(null);
    setSaving(true);
    try {
      const update = validateTunnelUpdate({
        expectedRevision: revision,
        hosts: [
          ...snapshot.config.hosts.filter((h) => h.id !== host.id),
          draft,
        ],
        backendEndpoints: [
          ...snapshot.config.backendEndpoints.filter(
            (e) => e.hostId !== host.id,
          ),
          ...endpoints,
        ],
      });
      onSaved(
        await (window.electronAPI as RunweaveElectronBridge).saveTunnels(
          update,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  });
  return (
    <form
      className="space-y-3 rounded-xl border border-primary/40 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="font-medium">
        {snapshot.config.hosts.some((h) => h.id === host.id)
          ? "编辑主机"
          : "添加主机"}
      </h3>
      <label className="block">
        名称
        <input
          className={inputClass}
          required
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>
      <label className="block">
        SSH 主机或配置别名
        <input
          className={inputClass}
          required
          placeholder="user@host 或 devbox"
          value={draft.sshTarget}
          onChange={(e) => patch({ sshTarget: e.target.value })}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        沿用本机 SSH 配置与密钥，请先确认终端中 SSH 可以连接。
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.autoConnect}
          onChange={(e) => patch({ autoConnect: e.target.checked })}
        />
        启动桌面端时自动连接
      </label>
      <h4 className="border-t border-border pt-3 font-medium">开发服务端口</h4>
      {draft.forwards.map((f, index) => (
        <fieldset key={f.id} className="space-y-2 rounded-lg bg-muted/30 p-3">
          <legend className="sr-only">端口 {index + 1}</legend>
          <label className="block">
            服务名称
            <input
              className={inputClass}
              value={f.name}
              onChange={(e) =>
                patch({
                  forwards: draft.forwards.map((item) =>
                    item.id === f.id ? { ...item, name: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          <label className="block">
            端口（本地与远端相同）
            <input
              className={inputClass}
              type="number"
              min="1"
              max="65535"
              required
              value={f.port || ""}
              onChange={(e) =>
                patch({
                  forwards: draft.forwards.map((item) =>
                    item.id === f.id
                      ? { ...item, port: Number(e.target.value) }
                      : item,
                  ),
                })
              }
            />
          </label>
          <label className="block">
            访问路径
            <input
              className={inputClass}
              value={f.path}
              onChange={(e) =>
                patch({
                  forwards: draft.forwards.map((item) =>
                    item.id === f.id ? { ...item, path: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) =>
                patch({
                  forwards: draft.forwards.map((item) =>
                    item.id === f.id
                      ? { ...item, enabled: e.target.checked }
                      : item,
                  ),
                })
              }
            />
            启用转发
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              patch({
                forwards: draft.forwards.filter((item) => item.id !== f.id),
              })
            }
          >
            移除端口
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          patch({
            forwards: [
              ...draft.forwards,
              {
                id: crypto.randomUUID(),
                name: "开发服务",
                port: 3000,
                path: "/",
                enabled: true,
              },
            ],
          })
        }
      >
        添加端口
      </Button>
      <label className="flex items-center gap-2 border-t border-border pt-3">
        <input
          type="checkbox"
          checked={draft.browser.enabled}
          onChange={(e) =>
            patch({ browser: { ...draft.browser, enabled: e.target.checked } })
          }
        />
        允许远端 Agent 使用本机 Browser
      </label>
      {draft.browser.enabled && (
        <>
          <label className="block">
            远端 Backend 端口
            <input
              type="number"
              className={inputClass}
              min="1"
              max="65535"
              required
              value={draft.browser.backendPort || ""}
              onChange={(e) =>
                patch({
                  browser: {
                    ...draft.browser,
                    backendPort: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="block">
            授权 Browser
            <select
              className={inputClass}
              value={draft.browser.profileId}
              onChange={(e) =>
                patch({
                  browser: {
                    ...draft.browser,
                    profileId: e.target
                      .value as TunnelHostConfig["browser"]["profileId"],
                  },
                })
              }
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={`profile-${n}`}>
                  Browser {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            允许复用的工作组 ID（可选）
            <input
              className={inputClass}
              value={draft.browser.approvedBrowserGroupId ?? ""}
              onChange={(e) =>
                patch({
                  browser: {
                    ...draft.browser,
                    approvedBrowserGroupId: e.target.value || null,
                  },
                })
              }
            />
          </label>
        </>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          高级 · Backend 访问入口
        </summary>
        <p className="my-2 text-xs text-muted-foreground">
          为只能通过 SSH 访问的 Backend
          保留内部入口。删除入口后，引用它的连接将等待通道。
        </p>
        {endpoints.map((endpoint) => (
          <div key={endpoint.id} className="my-2 flex items-center gap-2">
            <label>
              远端端口
              <input
                type="number"
                min="1"
                max="65535"
                className={inputClass}
                value={endpoint.remotePort || ""}
                onChange={(e) =>
                  setEndpoints(
                    endpoints.map((item) =>
                      item.id === endpoint.id
                        ? { ...item, remotePort: Number(e.target.value) }
                        : item,
                    ),
                  )
                }
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setEndpoints(
                  endpoints.filter((item) => item.id !== endpoint.id),
                )
              }
            >
              移除入口
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            setEndpoints([
              ...endpoints,
              { id: crypto.randomUUID(), hostId: host.id, remotePort: 5001 },
            ])
          }
        >
          添加 Backend 入口
        </Button>
      </details>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存配置"}
        </Button>
      </div>
    </form>
  );
}
