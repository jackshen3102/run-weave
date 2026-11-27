import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMemoizedFn } from "ahooks";
import {
  AGY_QUOTA_CACHE_MS,
  AGY_QUOTA_STATUS_LABELS,
  QUOTA_PACE_LABELS,
  computeQuotaWindowPace,
  type AgyQuotaGroup,
  type AgyQuotaSnapshot,
  type QuotaPaceState,
} from "@runweave/shared/app-server/agy-quota";
import {
  CODEX_QUOTA_CACHE_MS,
  CODEX_QUOTA_STATUS_LABELS,
  type CodexQuotaSnapshot,
  type CodexQuotaWindow,
} from "@runweave/shared/app-server/codex-quota";
import { fetchAgyQuota, fetchCodexQuota } from "../../services/codex-quota";
import { HttpError } from "../../services/http";
import { Button } from "../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { CodexQuotaContext } from "./context";

const PACE_BADGE_CLASSES: Record<QuotaPaceState, string> = {
  ahead: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  on: "border-border/60 bg-muted/50 text-muted-foreground",
  under: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
};

function formatCountdown(remainingSec: number): string {
  const totalMins = Math.max(0, Math.floor(remainingSec / 60));
  if (totalMins < 60) {
    return totalMins <= 1 ? "距重置不足 1 分钟" : `距重置还有 ${totalMins} 分钟`;
  }
  const totalHours = Math.floor(totalMins / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = totalMins % 60;
  if (days > 0) return `距重置还有 ${days} 天 ${hours} 小时`;
  return mins > 0 ? `距重置还有 ${hours} 小时 ${mins} 分钟` : `距重置还有 ${hours} 小时`;
}

function QuotaWindow({
  title,
  value,
  provider = "codex",
}: {
  title: string;
  value: CodexQuotaWindow | null;
  provider?: "codex" | "agy";
}) {
  const nowMs = Date.now();
  const paceInfo = value ? computeQuotaWindowPace(value, nowMs) : null;
  const remaining = paceInfo ? Number(paceInfo.remainingPercent.toFixed(1)) : null;
  const fillColor =
    remaining === null
      ? "bg-primary"
      : remaining <= 10
        ? "bg-red-500"
        : remaining <= 30
          ? "bg-amber-500"
          : provider === "agy"
            ? "bg-[#8c7bd1]"
            : "bg-primary";
  const remainingSec = value?.resetsAt != null ? value.resetsAt - nowMs / 1_000 : null;

  return (
    <section className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="truncate text-sm font-medium">{title}</h4>
          {paceInfo?.pace ? (
            <span
              className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${PACE_BADGE_CLASSES[paceInfo.pace]}`}
            >
              {QUOTA_PACE_LABELS[paceInfo.pace]}
            </span>
          ) : null}
        </div>
        <strong className="shrink-0 text-lg font-semibold tabular-nums">
          {remaining !== null ? `${remaining}%` : "未知"}
        </strong>
      </div>
      {value && remaining !== null ? (
        <>
          <div
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remaining}
            className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted/70"
          >
            <div
              className={`h-full rounded-full transition-all ${fillColor}`}
              style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }}
            />
            {paceInfo?.evenPaceRemainingPercent != null ? (
              <div
                aria-hidden="true"
                title={`匀速基准：当前应剩 ${Math.round(paceInfo.evenPaceRemainingPercent)}%`}
                className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 bg-foreground/90 shadow-[0_0_0_1px_hsl(var(--background))]"
                style={{
                  left: `${Math.max(2, Math.min(98, paceInfo.evenPaceRemainingPercent))}%`,
                }}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {value.resetsAt === null
                ? value.usedPercent === 0
                  ? "下次重置：未触发（首次消耗后开始计时）"
                  : "下次重置：未知"
                : remainingSec !== null && remainingSec <= 0
                  ? `下次重置：${new Date(value.resetsAt * 1_000).toLocaleString()}（已到期，请刷新确认）`
                  : `下次重置：${new Date(value.resetsAt * 1_000).toLocaleString()} · ${formatCountdown(remainingSec ?? 0)}`}
            </span>
            {paceInfo?.evenPaceRemainingPercent != null ? (
              <span className="tabular-nums">
                匀速基准：应剩 {Math.round(paceInfo.evenPaceRemainingPercent)}%
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">上游未提供此窗口</p>
      )}
    </section>
  );
}

function AgyQuotaGroupCard({ group }: { group: AgyQuotaGroup }) {
  return (
    <div className="space-y-2.5 rounded-xl border border-border/70 bg-background/50 p-3.5">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{group.name}</h3>
          <span className="rounded-full bg-[#8c7bd1]/15 px-2 py-0.5 text-[11px] font-medium text-[#a594e9]">
            共享配额池
          </span>
        </div>
        {group.description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{group.description}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        {group.windows.map((window) => (
          <QuotaWindow
            key={window.id}
            title={window.label}
            value={window}
            provider="agy"
          />
        ))}
      </div>
    </div>
  );
}

/** Mounted per authenticated connection. Closing cancels reads; no polling or persisted cache. */
export function CodexQuotaProvider({
  children,
  apiBase,
  token,
  connectionName,
  onUnauthorized,
  embedded = false,
}: {
  embedded?: boolean;
  children: ReactNode;
  apiBase: string;
  token: string | null;
  connectionName: string;
  onUnauthorized: () => void;
}) {
  const [open, setOpen] = useState(embedded);
  const [snapshot, setSnapshot] = useState<CodexQuotaSnapshot | null>(null);
  const [agySnapshot, setAgySnapshot] = useState<AgyQuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [agyFailure, setAgyFailure] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const receivedAt = useRef(0);
  const agyReceivedAt = useRef(0);

  const refresh = useMemoizedFn(async (force: boolean) => {
    if (!token) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailure(null);
    setAgyFailure(null);

    const loadCodex = async () => {
      try {
        const next = await fetchCodexQuota(apiBase, token, force, controller.signal);
        if (controller.signal.aborted) return;
        if (
          next.observedAt === null &&
          (next.status === "unavailable" || next.status === "incompatible")
        ) {
          setFailure(CODEX_QUOTA_STATUS_LABELS[next.status]);
        } else {
          setSnapshot(next);
          receivedAt.current = performance.now();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401) throw error;
        setFailure(error instanceof Error ? error.message : "Codex 额度更新失败");
      }
    };

    const loadAgy = async () => {
      try {
        const next = await fetchAgyQuota(apiBase, token, force, controller.signal);
        if (controller.signal.aborted) return;
        if (
          next.observedAt === null &&
          (next.status === "unavailable" || next.status === "incompatible")
        ) {
          setAgyFailure(AGY_QUOTA_STATUS_LABELS[next.status]);
        } else {
          setAgySnapshot(next);
          agyReceivedAt.current = performance.now();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401) throw error;
        setAgyFailure(error instanceof Error ? error.message : "AGY 额度更新失败");
      }
    };

    try {
      await Promise.all([loadAgy(), loadCodex()]);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof HttpError && error.status === 401) {
        setSnapshot(null);
        setAgySnapshot(null);
        setOpen(false);
        onUnauthorized();
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  });

  useEffect(() => {
    if (open) void refresh(false);
    return () => request.current?.abort();
  }, [open, refresh]);

  const codexAge =
    snapshot?.sampleAgeMs == null
      ? null
      : snapshot.sampleAgeMs + performance.now() - receivedAt.current;
  const agyAge =
    agySnapshot?.sampleAgeMs == null
      ? null
      : agySnapshot.sampleAgeMs + performance.now() - agyReceivedAt.current;
  const codexMessage =
    failure ?? (snapshot ? CODEX_QUOTA_STATUS_LABELS[snapshot.status] : null);
  const agyMessage =
    agyFailure ?? (agySnapshot ? AGY_QUOTA_STATUS_LABELS[agySnapshot.status] : null);

  const content = (
    <div className="space-y-5" aria-busy={loading}>
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#8c7bd1]" />
            <h3 className="text-sm font-semibold">Antigravity (AGY)</h3>
          </div>
          {agySnapshot?.observedAt ? (
            <span className="text-xs text-muted-foreground">
              更新于 {new Date(agySnapshot.observedAt).toLocaleTimeString()}
              {agyAge !== null && agyAge >= AGY_QUOTA_CACHE_MS ? "（旧记录）" : ""}
            </span>
          ) : null}
        </div>
        {agySnapshot && agySnapshot.groups.length > 0 ? (
          <div className="space-y-3">
            {agySnapshot.groups.map((group) => (
              <AgyQuotaGroupCard key={group.id} group={group} />
            ))}
          </div>
        ) : (
          <QuotaWindow title="每周剩余" value={null} provider="agy" />
        )}
        {agyMessage ? (
          <p role="status" className="text-sm text-amber-600">
            {agyMessage}
            {agySnapshot?.observedAt ? "；额度为上次记录" : ""}
          </p>
        ) : null}
      </section>

      <section className="space-y-3 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
            <h3 className="text-sm font-semibold">Codex · ChatGPT 订阅</h3>
          </div>
          {snapshot?.observedAt ? (
            <span className="text-xs text-muted-foreground">
              更新于 {new Date(snapshot.observedAt).toLocaleTimeString()}
              {codexAge !== null && codexAge >= CODEX_QUOTA_CACHE_MS ? "（旧记录）" : ""}
            </span>
          ) : null}
        </div>
        <QuotaWindow title="每周剩余" value={snapshot?.weekly ?? null} provider="codex" />
        {snapshot?.shortWindow ? (
          <QuotaWindow title="短周期剩余" value={snapshot.shortWindow} provider="codex" />
        ) : null}
        {codexMessage ? (
          <p role="status" className="text-sm text-amber-600">
            {codexMessage}
            {snapshot?.observedAt ? "；额度为上次记录" : ""}
          </p>
        ) : null}
      </section>

      <div className="flex items-center justify-between gap-3 pt-1">
        <Button onClick={() => void refresh(true)} disabled={loading}>
          {loading ? "正在更新…" : "刷新"}
        </Button>
        <p className="text-xs text-muted-foreground">
          仅打开或手动刷新时查询，竖线为匀速消耗基准。
        </p>
      </div>
    </div>
  );

  if (embedded) return content;
  return (
    <CodexQuotaContext.Provider value={token ? () => setOpen(true) : null}>
      {children}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>订阅额度</SheetTitle>
            <SheetDescription>
              {connectionName} · Antigravity (AGY) 与 Codex 订阅限额
            </SheetDescription>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    </CodexQuotaContext.Provider>
  );
}
