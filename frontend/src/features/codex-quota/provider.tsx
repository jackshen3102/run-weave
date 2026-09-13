import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMemoizedFn } from "ahooks";
import { CODEX_QUOTA_CACHE_MS, CODEX_QUOTA_STATUS_LABELS, type CodexQuotaSnapshot, type CodexQuotaWindow } from "@runweave/shared/app-server/codex-quota";
import { fetchCodexQuota } from "../../services/codex-quota";
import { HttpError } from "../../services/http";
import { Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { CodexQuotaContext } from "./context";

function QuotaWindow({ title, value }: { title: string; value: CodexQuotaWindow | null }) {
  return <section className="space-y-2 rounded-lg border border-border/60 p-4">
    <div className="flex items-center justify-between"><h3 className="text-sm">{title}</h3>
      <strong className="text-xl tabular-nums">{value ? `${Number((100 - value.usedPercent).toFixed(1))}%` : "未知"}</strong></div>
    {value ? <><progress aria-label={title} max={100} value={100 - value.usedPercent} className="h-2 w-full accent-primary" />
      <p className="text-xs text-muted-foreground">下次重置：{value.resetsAt === null ? "未知" : new Date(value.resetsAt * 1_000).toLocaleString()}{value.resetsAt !== null && value.resetsAt * 1_000 <= Date.now() ? "（已到期，请刷新确认）" : ""}</p></> : <p className="text-xs text-muted-foreground">上游未提供此窗口</p>}
  </section>;
}

/** Mounted per authenticated connection. Closing cancels reads; no polling or persisted cache. */
export function CodexQuotaProvider({ children, apiBase, token, connectionName, onUnauthorized }: {
  children: ReactNode; apiBase: string; token: string | null; connectionName: string; onUnauthorized: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<CodexQuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const receivedAt = useRef(0);
  const refresh = useMemoizedFn(async (force: boolean) => {
    if (!token) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailure(null);
    try {
      const next = await fetchCodexQuota(apiBase, token, force, controller.signal);
      if (controller.signal.aborted) return;
      // Transport/old-server failures must not erase the last successful sample.
      if (next.observedAt === null && (next.status === "unavailable" || next.status === "incompatible")) {
        setFailure(CODEX_QUOTA_STATUS_LABELS[next.status]);
      } else {
        setSnapshot(next);
        receivedAt.current = performance.now();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof HttpError && error.status === 401) {
        setSnapshot(null);
        setOpen(false);
        onUnauthorized();
      } else {
        setFailure(error instanceof Error ? error.message : "额度更新失败");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  });
  useEffect(() => {
    if (open) void refresh(false);
    return () => request.current?.abort();
  }, [open, refresh]);
  const age = snapshot?.sampleAgeMs == null ? null : snapshot.sampleAgeMs + performance.now() - receivedAt.current;
  const message = failure ?? (snapshot ? CODEX_QUOTA_STATUS_LABELS[snapshot.status] : null);
  return <CodexQuotaContext.Provider value={token ? () => setOpen(true) : null}>
    {children}
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="w-full sm:max-w-sm">
        <SheetHeader><SheetTitle>Codex 额度</SheetTitle><SheetDescription>{connectionName} · App Server 的 ChatGPT 订阅</SheetDescription></SheetHeader>
        <div className="space-y-4" aria-busy={loading}>
          <QuotaWindow title="每周剩余" value={snapshot?.weekly ?? null} />
          {snapshot?.shortWindow ? <QuotaWindow title="短周期剩余" value={snapshot.shortWindow} /> : null}
          {message ? <p role="status" className="text-sm text-amber-600">{message}{snapshot?.observedAt ? "；额度为上次记录" : ""}</p> : null}
          {snapshot?.observedAt ? <p className="text-xs text-muted-foreground">更新于 {new Date(snapshot.observedAt).toLocaleString()}{age !== null && age >= CODEX_QUOTA_CACHE_MS ? "（旧记录）" : ""}</p> : null}
          <Button onClick={() => void refresh(true)} disabled={loading}>{loading ? "正在更新…" : "刷新"}</Button>
          <p className="text-xs text-muted-foreground">仅打开或手动刷新时查询，不会持续监控。</p>
        </div>
      </SheetContent>
    </Sheet>
  </CodexQuotaContext.Provider>;
}
