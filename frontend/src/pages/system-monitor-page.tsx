import { AppRow, type SortKey } from "../features/system-monitor/app-row";
import { useMemoizedFn } from "ahooks";
import { useSearchParams } from "react-router-dom";
import type { TerminateProcessResult } from "@runweave/shared/resource-monitor";
import { resourceMonitorApi } from "../services/resource-monitor";
import { ResourceSettings } from "../features/system-monitor/resource-settings";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "../components/ui/alert-dialog";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Battery,
  BatteryCharging,
  Cpu,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import type {
  SystemMonitorAppGroup,
  SystemMonitorProcess,
  SystemMonitorSnapshot,
} from "@runweave/shared/system-monitor";
import { Button } from "../components/ui/button";
import { RuntimeStatusEntry } from "../components/runtime-status-entry";
import { useSystemMonitor } from "../features/system-monitor/use-system-monitor";
import {
  formatMemory,
  formatPercent,
  formatTime,
} from "../features/system-monitor/format";

const VISIBLE_APP_COUNT = 50;

interface SystemMonitorPageProps {
  onNavigateTerminal?: () => void;
}

function MetricBar(params: { value: number | null; tone?: "ok" | "warn" }) {
  const width =
    params.value === null || !Number.isFinite(params.value)
      ? 0
      : Math.max(0, Math.min(100, params.value));
  const barClass =
    params.tone === "warn" ? "bg-amber-500" : "bg-[hsl(var(--primary))]";

  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full ${barClass}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function OverviewCard(params: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  barValue?: number | null;
  tone?: "ok" | "warn";
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-card/85 p-4 shadow-[0_18px_70px_-54px_rgba(17,24,39,0.75)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
          {params.icon}
          <span className="truncate">{params.label}</span>
        </div>
        <strong className="text-xl font-semibold tabular-nums text-foreground">
          {params.value}
        </strong>
      </div>
      {params.barValue !== undefined ? (
        <div className="mt-4">
          <MetricBar value={params.barValue} tone={params.tone} />
        </div>
      ) : null}
      <p className="mt-3 truncate text-xs text-muted-foreground">
        {params.detail}
      </p>
    </section>
  );
}

function EmptyState(params: {
  title: string;
  body: string;
  onNavigateTerminal?: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-lg rounded-lg border border-border/70 bg-card/90 p-8 text-center shadow-[0_24px_90px_-58px_rgba(17,24,39,0.75)]">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-muted">
          <Activity className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold text-foreground">
          {params.title}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {params.body}
        </p>
        {params.onNavigateTerminal ? (
          <Button className="mt-6" onClick={params.onNavigateTerminal}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Terminals
          </Button>
        ) : null}
      </section>
    </main>
  );
}

function getMemoryPercent(snapshot: SystemMonitorSnapshot): number {
  if (snapshot.memory.totalMb <= 0) {
    return 0;
  }
  return Math.round((snapshot.memory.usedMb / snapshot.memory.totalMb) * 100);
}

function sortApps(apps: SystemMonitorAppGroup[], sortKey: SortKey) {
  return [...apps].sort((a, b) => {
    const primary =
      sortKey === "energy"
        ? (b.energyImpact ?? -1) - (a.energyImpact ?? -1)
        : sortKey === "cpu"
          ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)
          : b.memoryMb - a.memoryMb;
    return (
      primary ||
      (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) ||
      b.memoryMb - a.memoryMb
    );
  });
}

export function SystemMonitorPage({
  onNavigateTerminal,
}: SystemMonitorPageProps) {
  const [paused, setPaused] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("energy");
  const [searchParams] = useSearchParams();
  const [expandedAppKey, setExpandedAppKey] = useState<string | null>(
    searchParams.get("app"),
  );
  const [results, setResults] = useState<
    Record<string, TerminateProcessResult | string>
  >({});
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [target, setTarget] = useState<{
    process: SystemMonitorProcess;
    force: boolean;
  } | null>(null);
  const { snapshot, resource } = useSystemMonitor(paused);
  const { data, error, refresh } = resource;
  useEffect(() => {
    const key = searchParams.get("app");
    if (key) setExpandedAppKey(key);
  }, [searchParams]);
  useEffect(() => {
    if (expandedAppKey)
      document
        .getElementById(`resource-app-${expandedAppKey}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [expandedAppKey]);
  const confirmTerminate = useMemoizedFn(async () => {
    if (
      !target ||
      !resource.token ||
      pendingRef.current ||
      !target.process.processInstanceId
    )
      return;
    const selected = target;
    const id = selected.process.processInstanceId!;
    pendingRef.current = true;
    setPending(id);
    setTarget(null);
    try {
      const result = await resourceMonitorApi(
        resource.apiBase,
        resource.token,
      ).terminate(id, selected.force, crypto.randomUUID());
      setResults((current) => ({ ...current, [id]: result }));
    } catch (cause) {
      setResults((current) => ({
        ...current,
        [id]: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  });
  if (data?.status === "unsupported")
    return (
      <EmptyState
        title="需要 macOS Backend"
        body="当前连接的电脑尚不支持资源采样。"
        onNavigateTerminal={onNavigateTerminal}
      />
    );

  const memoryPercent = snapshot ? getMemoryPercent(snapshot) : 0;
  const sortedApps = snapshot
    ? sortApps(snapshot.apps, sortKey).slice(0, VISIBLE_APP_COUNT)
    : [];
  const processByApp = new Map<string, SystemMonitorProcess[]>();
  for (const process of snapshot?.processes ?? []) {
    const current = processByApp.get(process.appKey) ?? [];
    current.push(process);
    processByApp.set(process.appKey, current);
  }

  return (
    <main className="min-h-screen bg-background px-4 py-5 text-foreground md:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
          <div className="min-w-0">
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              Runweave
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal">
              系统监控
            </h1>
            <p className="mt-2 text-xs text-muted-foreground">
              {data?.hostName ?? "当前连接的电脑"} ·{" "}
              {data?.status === "ok"
                ? `最近采样 ${formatTime(snapshot?.sampledAt ?? null)}`
                : data?.status === "disabled"
                  ? "后台资源监控已关闭"
                  : data?.status === "stale"
                    ? "采样已过期"
                    : data?.status === "error"
                      ? "采样失败，显示上次数据"
                      : "观察中"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RuntimeStatusEntry />
            {onNavigateTerminal ? (
              <Button variant="ghost" size="sm" onClick={onNavigateTerminal}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Terminals
              </Button>
            ) : null}
            <ResourceSettings onSaved={refresh} />
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw className="h-4 w-4" />
              <span className="sr-only">刷新缓存</span>
            </Button>
            <Button
              variant={paused ? "default" : "secondary"}
              size="sm"
              onClick={() => setPaused((current) => !current)}
            >
              <span className="sr-only">
                {paused ? "继续显示" : "暂停显示"}
              </span>
              {paused ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
            </Button>
          </div>
        </header>

        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {data?.alerts[0] ? (
          <aside
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
          >
            <div>
              <strong>
                {data.alerts[0].appName}{" "}
                {data.alerts[0].ruleId === "energy"
                  ? "能耗影响较高"
                  : "内存占用较大"}
              </strong>
              <p className="mt-1 text-xs text-muted-foreground">
                近 5 分钟多次检测到高占用
                {data.alerts[0].ruleId === "memory"
                  ? "；内存占用不代表耗电量"
                  : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => setExpandedAppKey(data.alerts[0]!.appKey)}
              >
                查看进程
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void resource
                    .snooze(data.alerts[0]!.alertId)
                    .then(() => {
                      resource.dismissNotice();
                      refresh();
                    })
                    .catch(() => {});
                }}
              >
                忽略 1 小时
              </Button>
            </div>
          </aside>
        ) : null}
        {expandedAppKey &&
        snapshot &&
        !sortedApps.some((app) => app.appKey === expandedAppKey) ? (
          <p role="status" className="text-sm text-muted-foreground">
            该提醒对应的应用已退出或不在当前列表中。
          </p>
        ) : null}
        {resource.notificationError ? (
          <p role="alert" className="text-sm text-destructive">
            {resource.notificationError}
          </p>
        ) : null}
        {resource.unsupportedBackend ? (
          <p role="alert" className="text-sm text-muted-foreground">
            当前 Backend 尚不支持资源监控，请更新 Backend。
          </p>
        ) : null}
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <OverviewCard
            label="CPU"
            value={snapshot ? formatPercent(snapshot.cpu.totalPercent) : "-"}
            detail={
              snapshot?.cpu.warmingUp
                ? "观察中"
                : `${snapshot?.cpu.coreCount ?? 0} 核心`
            }
            icon={<Cpu className="h-4 w-4" />}
            barValue={snapshot?.cpu.totalPercent ?? null}
          />
          <OverviewCard
            label="内存"
            value={snapshot ? `${memoryPercent}%` : "-"}
            detail={
              snapshot
                ? `${formatMemory(snapshot.memory.usedMb)} / ${formatMemory(snapshot.memory.totalMb)} · ${snapshot.memory.pressure}`
                : "-"
            }
            icon={<MemoryStick className="h-4 w-4" />}
            barValue={memoryPercent}
            tone={
              snapshot?.memory.pressure === "warn" ||
              snapshot?.memory.pressure === "critical"
                ? "warn"
                : "ok"
            }
          />
          <OverviewCard
            label="Swap"
            value={snapshot ? formatMemory(snapshot.memory.swapUsedMb) : "-"}
            detail={
              data?.settings.monitorEnabled
                ? "后台每分钟采样"
                : "后台采样已关闭"
            }
            icon={<Activity className="h-4 w-4" />}
          />
          <OverviewCard
            label="电池"
            value={
              snapshot?.battery.available
                ? `${snapshot.battery.percent}%`
                : "未知"
            }
            detail={
              snapshot?.battery.available
                ? `${snapshot.battery.powerSource === "ac" ? "接电" : snapshot.battery.powerSource === "battery" ? "电池供电" : "供电未知"} · ${snapshot.battery.dischargePowerW == null ? "放电功率未知" : `估算放电 ${snapshot.battery.dischargePowerW.toFixed(1)} W`}`
                : "电池数据未知"
            }
            icon={
              snapshot?.battery.available && snapshot.battery.charging ? (
                <BatteryCharging className="h-4 w-4" />
              ) : (
                <Battery className="h-4 w-4" />
              )
            }
            barValue={
              snapshot?.battery.available ? snapshot.battery.percent : null
            }
          />
        </section>

        <section className="flex flex-col rounded-lg border border-border/70 bg-card/85 shadow-[0_24px_90px_-58px_rgba(17,24,39,0.75)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div>
              <h2 className="text-lg font-semibold">高占用应用与进程</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                最近采样 {formatTime(snapshot?.sampledAt ?? null)}
              </p>
            </div>
            <div className="flex rounded-lg border border-border/70 bg-background/70 p-1">
              <Button
                variant={sortKey === "energy" ? "default" : "ghost"}
                size="sm"
                onClick={() => setSortKey("energy")}
              >
                能耗影响
              </Button>
              <Button
                variant={sortKey === "cpu" ? "default" : "ghost"}
                size="sm"
                onClick={() => setSortKey("cpu")}
              >
                CPU Core
              </Button>
              <Button
                variant={sortKey === "memory" ? "default" : "ghost"}
                size="sm"
                onClick={() => setSortKey("memory")}
              >
                RSS Sum
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] table-fixed text-sm">
              <thead className="border-b border-border/70 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">App</th>
                  <th className="w-28 px-4 py-3 text-right font-medium">
                    能耗影响
                  </th>
                  <th className="w-32 px-4 py-3 text-right font-medium">
                    CPU Core
                  </th>
                  <th className="w-36 px-4 py-3 text-right font-medium">
                    RSS Sum
                  </th>
                  <th className="w-28 px-4 py-3 text-right font-medium">
                    Procs
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {sortedApps.length > 0 ? (
                  sortedApps.map((app) => (
                    <AppRow
                      key={app.appKey}
                      app={app}
                      results={results}
                      pending={pending}
                      canTerminate={
                        data?.canTerminate === true && !error && !paused
                      }
                      onTerminate={(process, force) =>
                        setTarget({ process, force })
                      }
                      processes={processByApp.get(app.appKey) ?? []}
                      expanded={expandedAppKey === app.appKey}
                      sortKey={sortKey}
                      onToggle={() => {
                        setExpandedAppKey((current) =>
                          current === app.appKey ? null : app.appKey,
                        );
                      }}
                    />
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-12 text-center text-muted-foreground"
                    >
                      {snapshot ? "暂无进程数据。" : "正在等待 Backend 采样…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">
            能耗影响按 CPU 与唤醒次数估算，不能完整归因
            GPU、网络等耗电，也不是应用瓦数。进程 CPU 的 100% 表示一个核心；RSS
            合计可能重复计入共享页。采样覆盖{" "}
            {data?.coverage.matchedProcesses ?? 0}/
            {data?.coverage.knownProcesses ?? 0} 个进程，未知值显示「—」。
            {Object.values(results).some(
              (result) =>
                typeof result === "object" && result.state !== "still_running",
            ) ? (
              <p className="mt-2">
                只结束了选定进程；该应用仍可能有其他进程运行。电池功率将在下次后台采样更新。
              </p>
            ) : null}
          </div>
        </section>
      </div>
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <AlertDialogContent className="rounded-lg border-border bg-card text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.force
                ? "强制结束这个进程？"
                : target?.process.actionKind === "stop_service"
                  ? "停止这个服务？"
                  : "结束这个进程？"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-muted-foreground">
                <p>
                  {target?.process.displayName} · PID {target?.process.pid} ·{" "}
                  {data?.hostName}
                </p>
                <p>
                  CPU {formatPercent(target?.process.cpuPercent ?? null)} · RSS{" "}
                  {formatMemory(target?.process.memoryMb ?? 0)}
                </p>
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-foreground">
                  未保存的内容可能丢失。
                  {target?.process.actionKind === "stop_service"
                    ? `将停止 ${target.process.serviceName} 服务及其子进程；必要时按服务生命周期强制结束。`
                    : "此操作只结束选中的进程。"}
                  {target?.force ? "强制结束不会等待程序自行退出。" : ""}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmTerminate()}
            >
              {target?.force
                ? "强制结束"
                : target?.process.actionKind === "stop_service"
                  ? "停止服务"
                  : "结束进程"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
