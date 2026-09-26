import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { ConfigurationStatus } from "@runweave/shared/configuration";
import { Button } from "../../components/ui/button";

export function DesktopConfigurationStatus() {
  const [status, setStatus] = useState<ConfigurationStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useMemoizedFn(async () => {
    setBusy(true); setFailure(null);
    try {
      const next = await window.electronAPI?.getLocalConfigurationStatus?.();
      if (mounted.current && next) setStatus(next);
    } catch { if (mounted.current) setFailure("无法读取本台桌面的配置状态。"); }
    finally { if (mounted.current) setBusy(false); }
  });
  if (!window.electronAPI?.getLocalConfigurationStatus) return null;
  return <details className="rounded-xl border border-border p-4">
    <summary className="cursor-pointer font-medium">本台桌面的配置状态</summary>
    <div className="mt-3 space-y-2 text-xs">
      <p>浏览器、远程访问和伴随窗口由本台桌面管理。</p>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>刷新桌面状态</Button>
      {failure && <p role="alert">{failure}</p>}
      {status && <>
        <p>{status.environment.kind === "stable" ? "Stable" : "Dev Session"} · {status.environment.instanceId} · 保存版本 {status.savedRevision ?? "不可读取"}</p>
        {status.diskError && <p role="alert">磁盘配置无法读取，当前进程仍保留已采用的配置。</p>}
        {Object.entries(status.consumers).map(([key, value]) => <p key={key} className="break-all">
          {key}：{value.state === "error" ? "配置错误" : value.state === "applied" ? "已生效" : value.state === "unconfigured" ? "未配置" : "等待所属功能重新加载或重启"}
          {value.appliedRevision !== null && ` · 生效版本 ${value.appliedRevision}`}
        </p>)}
      </>}
    </div>
  </details>;
}
