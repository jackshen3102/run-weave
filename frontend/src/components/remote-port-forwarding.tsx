import { useEffect, useRef, useState } from "react";
import { useLocalStorageState, useMemoizedFn } from "ahooks";
import type { ManualRemotePortAccess } from "@runweave/shared/remote";
import type { ConnectionConfig } from "../features/connection/types";
import { openTerminalBrowserUrl } from "../features/terminal/navigation/open-browser";
import { Button } from "./ui/button";

interface ForwardDraft {
  port: string;
  path: string;
}

function resolveForwardUrl(base: string, path: string): string {
  const value = path.trim() || "/";
  const url = new URL(value, base);
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || url.origin !== new URL(base).origin) {
    throw new Error("访问路径须以 / 开头，例如 /chat/");
  }
  return url.toString();
}

export function RemotePortForwarding({ connection, onForward }: {
  connection: ConnectionConfig;
  onForward: (id: string, port: number) => Promise<ManualRemotePortAccess>;
}) {
  const [draft, setDraft] = useLocalStorageState<ForwardDraft>(`viewer.remote-forward.${connection.id}`, {
    defaultValue: { port: "3000", path: "/" },
  });
  const port = typeof draft?.port === "string" ? draft.port : "3000";
  const path = typeof draft?.path === "string" ? draft.path : "/";
  const [forwarded, setForwarded] = useState<ManualRemotePortAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    setForwarded(null);
    setBusy(false);
    setError(null);
    return () => { requestId.current += 1; };
  }, [connection.id, connection.generation]);

  const forward = useMemoizedFn(async () => {
    if (busy) return;
    const remotePort = Number(port);
    const currentRequest = ++requestId.current;
    setError(null);
    setForwarded(null);
    try {
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error("请输入 1–65535 之间的端口");
      resolveForwardUrl("http://127.0.0.1", path);
      setBusy(true);
      const result = await onForward(connection.id, remotePort);
      if (requestId.current === currentRequest) setForwarded(result);
    } catch (cause) {
      if (requestId.current === currentRequest) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId.current === currentRequest) setBusy(false);
    }
  });

  let desktopUrl: string | null = null;
  if (forwarded?.connectionId === connection.id && forwarded.generation === connection.generation && forwarded.remotePort === Number(port)) {
    try { desktopUrl = resolveForwardUrl(forwarded.desktopUrl, path); } catch { /* Validation is shown when forwarding. */ }
  }

  const open = useMemoizedFn(async () => {
    if (!desktopUrl) return;
    try {
      setError(null);
      await openTerminalBrowserUrl({ url: desktopUrl, profileId: connection.browserProfileId ?? undefined, placement: { kind: "new-group" } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  });

  return <details className="mt-2 w-full border-t border-border/50 pt-2 text-xs">
    <summary className="cursor-pointer text-muted-foreground">开发服务端口转发（可选）</summary>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label htmlFor={`forward-${connection.id}`}>远端服务端口</label>
      <input id={`forward-${connection.id}`} type="number" min="1" max="65535" value={port} disabled={busy} onChange={(event) => { setDraft({ port: event.target.value, path }); setError(null); }} className="w-24 rounded-md border border-border bg-background px-2 py-1" />
      <label htmlFor={`forward-path-${connection.id}`}>访问路径</label>
      <input id={`forward-path-${connection.id}`} value={path} disabled={busy} placeholder="例如 /chat/" onChange={(event) => { setDraft({ port, path: event.target.value }); setError(null); }} className="min-w-24 flex-1 rounded-md border border-border bg-background px-2 py-1" />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void forward()}>{busy ? "转发中…" : "转发"}</Button>
    </div>
    <p className="mt-2 text-muted-foreground">本地与远端使用相同端口，可直接用于代理配置。端口被占用时请自行调整；重连后需再次点击转发。</p>
    {desktopUrl ? <div className="mt-2">
      <p className="break-all text-muted-foreground">远端 {forwarded?.remotePort} → {desktopUrl}</p>
      <Button size="sm" variant="ghost" onClick={() => void open()}>打开网页</Button>
    </div> : null}
    {error ? <p className="mt-2 text-red-500" role="alert">{error}</p> : null}
  </details>;
}
