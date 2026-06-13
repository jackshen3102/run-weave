import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Battery,
  BatteryCharging,
  ChevronDown,
  ChevronRight,
  Cpu,
  Home,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import type {
  SystemMonitorAppGroup,
  SystemMonitorProcess,
  SystemMonitorSnapshot,
} from "@runweave/shared";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useSystemMonitor } from "../features/system-monitor/use-system-monitor";
import {
  formatBatteryRate,
  formatBatteryTime,
  formatMemory,
  formatPercent,
  formatTime,
} from "../features/system-monitor/format";

type SortKey = "cpu" | "memory";

const REFRESH_INTERVALS = [
  { label: "2s", value: 2_000 },
  { label: "5s", value: 5_000 },
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
];

const VISIBLE_APP_COUNT = 50;

interface SystemMonitorPageProps {
  onNavigateHome?: () => void;
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
  onNavigateHome?: () => void;
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
        {params.onNavigateHome ? (
          <Button className="mt-6" onClick={params.onNavigateHome}>
            <Home className="mr-2 h-4 w-4" />
            Home
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
      sortKey === "cpu" ? b.cpuPercent - a.cpuPercent : b.memoryMb - a.memoryMb;
    return primary || b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb;
  });
}

function processDisplayName(process: SystemMonitorProcess): string {
  const displayName = process.displayName.trim();
  if (displayName.length <= 72) {
    return displayName;
  }
  return `${displayName.slice(0, 69)}...`;
}

function AppRow(params: {
  app: SystemMonitorAppGroup;
  processes: SystemMonitorProcess[];
  expanded: boolean;
  sortKey: SortKey;
  onToggle: () => void;
}) {
  const sortedProcesses = useMemo(() => {
    return [...params.processes].sort((a, b) => {
      const primary =
        params.sortKey === "cpu"
          ? b.cpuPercent - a.cpuPercent
          : b.memoryMb - a.memoryMb;
      return primary || b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb;
    });
  }, [params.processes, params.sortKey]);

  return (
    <>
      <tr
        className={params.app.isCurrentApp ? "bg-[hsl(var(--primary))]/8" : ""}
      >
        <td className="min-w-0 px-4 py-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={params.onToggle}
          >
            {params.expanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium">{params.app.appName}</span>
            {params.app.isCurrentApp ? (
              <span className="rounded-full bg-[hsl(var(--primary))]/14 px-2 py-0.5 text-[0.68rem] font-medium text-[hsl(var(--primary))]">
                Runweave
              </span>
            ) : null}
          </button>
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatPercent(params.app.cpuPercent)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatMemory(params.app.memoryMb)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {params.app.processCount}
        </td>
      </tr>
      {params.expanded ? (
        <tr>
          <td
            colSpan={4}
            className="border-y border-border/60 bg-muted/35 px-4 py-3"
          >
            {sortedProcesses.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border/70 bg-background/70">
                <table className="w-full table-fixed text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="w-24 px-3 py-2 text-left font-medium">
                        PID
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        Process
                      </th>
                      <th className="w-24 px-3 py-2 text-right font-medium">
                        CPU Core
                      </th>
                      <th className="w-28 px-3 py-2 text-right font-medium">
                        Memory
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProcesses.slice(0, 12).map((process) => (
                      <tr
                        key={process.pid}
                        className="border-t border-border/50"
                      >
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {process.pid}
                        </td>
                        <td className="truncate px-3 py-2">
                          {processDisplayName(process)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPercent(process.cpuPercent)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMemory(process.memoryMb)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Process details are outside the current top process window.
              </p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function SystemMonitorPage({ onNavigateHome }: SystemMonitorPageProps) {
  const [intervalMs, setIntervalMs] = useState(5_000);
  const [paused, setPaused] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [expandedAppKey, setExpandedAppKey] = useState<string | null>(null);
  const { snapshot, frames, error, refresh } = useSystemMonitor({
    intervalMs,
    paused,
  });

  const isElectron = window.electronAPI?.isElectron === true;
  if (!isElectron) {
    return (
      <EmptyState
        title="Mac only beta"
        body="System Monitor is available in the macOS Electron client."
        onNavigateHome={onNavigateHome}
      />
    );
  }

  if (snapshot?.platform === "other") {
    return (
      <EmptyState
        title="macOS required"
        body="This snapshot source is only implemented for macOS."
        onNavigateHome={onNavigateHome}
      />
    );
  }

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
  const currentInterval =
    REFRESH_INTERVALS.find((item) => item.value === intervalMs)?.label ?? "5s";

  return (
    <main className="min-h-screen bg-background px-4 py-5 text-foreground md:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
          <div className="min-w-0">
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              Runweave
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal">
              System Monitor
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onNavigateHome ? (
              <Button variant="ghost" size="sm" onClick={onNavigateHome}>
                <Home className="mr-2 h-4 w-4" />
                Home
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {currentInterval}
                  <ChevronDown className="ml-2 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={String(intervalMs)}
                  onValueChange={(value) => setIntervalMs(Number(value))}
                >
                  {REFRESH_INTERVALS.map((item) => (
                    <DropdownMenuRadioItem
                      key={item.value}
                      value={String(item.value)}
                    >
                      {item.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant={paused ? "default" : "secondary"}
              size="sm"
              onClick={() => setPaused((current) => !current)}
            >
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

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <OverviewCard
            label="CPU"
            value={snapshot ? formatPercent(snapshot.cpu.totalPercent) : "-"}
            detail={
              snapshot?.cpu.warmingUp
                ? "warming up"
                : `${snapshot?.cpu.coreCount ?? 0} cores`
            }
            icon={<Cpu className="h-4 w-4" />}
            barValue={snapshot?.cpu.totalPercent ?? null}
          />
          <OverviewCard
            label="Memory"
            value={snapshot ? `${memoryPercent}%` : "-"}
            detail={
              snapshot
                ? `${formatMemory(snapshot.memory.usedMb)} / ${formatMemory(snapshot.memory.totalMb)} · ${snapshot.memory.pressure}`
                : "-"
            }
            icon={<MemoryStick className="h-4 w-4" />}
            barValue={memoryPercent}
            tone={snapshot?.memory.pressure === "normal" ? "ok" : "warn"}
          />
          <OverviewCard
            label="Swap"
            value={snapshot ? formatMemory(snapshot.memory.swapUsedMb) : "-"}
            detail={`${frames.length} in-memory frames`}
            icon={<Activity className="h-4 w-4" />}
          />
          <OverviewCard
            label="Battery"
            value={
              snapshot?.battery.available
                ? `${snapshot.battery.percent}%`
                : "Unavailable"
            }
            detail={
              snapshot?.battery.available
                ? `${snapshot.battery.charging ? "charging" : "battery"} · ${formatBatteryRate(snapshot.battery.dischargeRateMa)} · ${formatBatteryTime(snapshot.battery.timeRemainingMin)}`
                : "no battery source"
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
              <h2 className="text-lg font-semibold">Top Apps</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Last sample {formatTime(snapshot?.sampledAt ?? null)}
              </p>
            </div>
            <div className="flex rounded-lg border border-border/70 bg-background/70 p-1">
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
                Memory
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] table-fixed text-sm">
              <thead className="border-b border-border/70 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">App</th>
                  <th className="w-32 px-4 py-3 text-right font-medium">
                    CPU Core
                  </th>
                  <th className="w-36 px-4 py-3 text-right font-medium">
                    Memory
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
                      colSpan={4}
                      className="px-4 py-12 text-center text-muted-foreground"
                    >
                      {snapshot
                        ? "No process data returned."
                        : "Loading snapshot..."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">
            Data source: ps + os.cpus delta + memory_pressure + sysctl + pmset +
            ioreg. App and process CPU use macOS per-core scale; 100% equals one
            logical core. No sudo.
          </div>
        </section>
      </div>
    </main>
  );
}
