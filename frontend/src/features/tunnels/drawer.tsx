import type { RunweaveElectronBridge } from "@runweave/shared/desktop-bridge";
import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { TunnelHostConfig } from "@runweave/shared/tunnels";
import { HostForm } from "./host-form";
import { BrowserStatus } from "./browser-status";
import { labels } from "./presentation";
import { Button } from "../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
import { openTerminalBrowserUrl } from "../terminal/navigation/open-browser";
import { useTunnelStore } from "./store";

const freshHost = (): TunnelHostConfig => ({
  id: crypto.randomUUID(),
  name: "",
  sshTarget: "",
  autoConnect: false,
  forwards: [],
  browser: {
    enabled: false,
    backendPort: 5001,
    profileId: "profile-1",
    approvedBrowserGroupId: null,
  },
});

export function TunnelDrawer() {
  const {
    snapshot,
    open,
    error,
    notice,
    setOpen,
    setSnapshot,
    setError,
    setNotice,
  } = useTunnelStore();
  const [editing, setEditing] = useState<TunnelHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = window.electronAPI as RunweaveElectronBridge | undefined;
    if (!api?.isElectron) return;
    let disposed = false;
    const subscriptions = [
      api.onTunnelsChanged(setSnapshot),
      api.onTunnelNotice(setNotice),
      api.onOpenTunnels(() => setOpen(true)),
    ];
    void api
      .listTunnels()
      .then((s) => {
        if (!disposed) setSnapshot(s);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [setSnapshot, setError, setNotice, setOpen]);
  const run = useMemoizedFn(async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });
  const remove = useMemoizedFn(async (host: TunnelHostConfig) => {
    if (
      !snapshot ||
      !window.confirm(
        `删除 ${host.name}？此主机的隧道将停止，远端任务不受影响。`,
      )
    )
      return;
    await run(async () =>
      setSnapshot(
        await (window.electronAPI as RunweaveElectronBridge).saveTunnels({
          expectedRevision: snapshot.config.revision,
          hosts: snapshot.config.hosts.filter((h) => h.id !== host.id),
          backendEndpoints: snapshot.config.backendEndpoints.filter(
            (e) => e.hostId !== host.id,
          ),
        }),
      ),
    );
  });
  if (!window.electronAPI?.isElectron) return null;
  return (
    <>
      {notice && !open && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border border-border bg-background p-3 text-sm shadow-lg"
        >
          <p>{notice}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(true);
              setNotice(null);
            }}
          >
            查看端口与隧道
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
            关闭
          </Button>
        </div>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:w-[560px]">
          <SheetTitle>端口与隧道</SheetTitle>
          <SheetDescription>
            管理这台电脑的 SSH
            通道。切换连接或关闭面板不影响运行；退出桌面端后停止。
          </SheetDescription>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {snapshot?.owner.devSessionId
                ? "Dev Session · 独立配置"
                : "本机用户配置"}
            </span>
            <Button
              size="sm"
              disabled={busy || !snapshot}
              onClick={() => setEditing(freshHost())}
            >
              添加 SSH 主机
            </Button>
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/30 p-3 text-sm text-red-500"
            >
              {error}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void run(async () =>
                    setSnapshot(
                      await (
                        window.electronAPI as RunweaveElectronBridge
                      ).listTunnels(),
                    ),
                  )
                }
              >
                重新读取
              </Button>
            </div>
          )}
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {editing && snapshot ? (
            <HostForm
              key={editing.id}
              host={editing}
              snapshot={snapshot}
              onCancel={() => setEditing(null)}
              onSaved={(next) => {
                setSnapshot(next);
                setEditing(null);
                setNotice("配置已保存，运行结果见各通道状态。");
              }}
            />
          ) : null}
          {!snapshot && !error && <p>读取配置中…</p>}
          {snapshot?.config.hosts.length === 0 && !editing && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              添加 SSH 主机后，可转发开发服务端口，或允许远端 Agent 使用本机
              Browser。
            </div>
          )}
          {snapshot?.config.hosts.map((host) => {
            const runtime = snapshot.hosts.find((h) => h.hostId === host.id);
            return (
              <section
                key={host.id}
                className="space-y-4 rounded-xl border border-border p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{host.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {host.sshTarget}
                    </p>
                    <p className="mt-1 text-sm">
                      {labels[runtime?.state ?? "disconnected"]}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          runtime?.state === "ready" ||
                          runtime?.state === "connecting" ||
                          runtime?.state === "reconnecting"
                            ? (
                                window.electronAPI as RunweaveElectronBridge
                              ).disconnectTunnel(host.id)
                            : (
                                window.electronAPI as RunweaveElectronBridge
                              ).connectTunnel(host.id),
                        )
                      }
                    >
                      {runtime?.state === "ready" ||
                      runtime?.state === "connecting" ||
                      runtime?.state === "reconnecting"
                        ? "断开"
                        : "连接"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(structuredClone(host))}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(host)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                {runtime?.error && (
                  <p role="alert" className="text-sm text-amber-600">
                    {runtime.error.message}
                  </p>
                )}
                <div className="space-y-2 border-t border-border pt-3">
                  <h4 className="text-sm font-medium">开发服务端口</h4>
                  {host.forwards.length === 0 ? (
                    <p className="text-xs text-muted-foreground">尚未配置</p>
                  ) : (
                    host.forwards.map((f) => {
                      const state = runtime?.forwards[f.id];
                      return (
                        <div
                          key={f.id}
                          className="rounded-lg bg-muted/40 p-3 text-sm"
                        >
                          <div className="flex justify-between gap-2">
                            <span>
                              {f.name} · {f.port} → {f.port}
                            </span>
                            <span>
                              {
                                labels[
                                  state?.state ??
                                    (f.enabled ? "waiting" : "disabled")
                                ]
                              }
                            </span>
                          </div>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            http://127.0.0.1:{f.port}
                            {f.path}
                          </p>
                          {state?.error && (
                            <p role="alert" className="mt-2 text-amber-600">
                              {state.error.message}
                            </p>
                          )}
                          {state?.state === "failed" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  (
                                    window.electronAPI as RunweaveElectronBridge
                                  ).retryTunnel(host.id, f.id),
                                )
                              }
                            >
                              重试转发
                            </Button>
                          )}
                          {state?.state === "ready" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void run(() =>
                                  openTerminalBrowserUrl({
                                    url: `http://127.0.0.1:${f.port}${f.path}`,
                                    profileId: host.browser.profileId,
                                    placement: { kind: "new-group" },
                                  }),
                                )
                              }
                            >
                              打开网页
                            </Button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
                <BrowserStatus
                  host={host}
                  runtime={runtime}
                  run={run}
                  busy={busy}
                />
              </section>
            );
          })}
        </SheetContent>
      </Sheet>
    </>
  );
}
