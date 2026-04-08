import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";
import { Activity } from "lucide-react";
import { formatRuntimeSummary } from "../features/electron.runtime-monitor-format";
import { useElectronRuntimeStats } from "../features/use-electron-runtime-stats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

function formatCpuPercent(value: number | null): string {
  return value === null ? "--" : `${Number(value.toFixed(2))}%`;
}

function formatMemoryMb(value: number | null): string {
  return value === null ? "--" : `${value} MB`;
}

function RuntimeDetailRow(props: {
  label: string;
  cpuPercent: number | null;
  memoryMb: number | null;
}) {
  const { label, cpuPercent, memoryMb } = props;

  return (
    <div className="flex items-center justify-between gap-6 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="text-right text-foreground/90">
        {formatCpuPercent(cpuPercent)} · {formatMemoryMb(memoryMb)}
      </span>
    </div>
  );
}

function renderProcessLabel(process: RuntimeStatsSnapshot["electron"]["processes"][number]): string {
  if (process.name) {
    return `${process.type} · ${process.name}`;
  }
  if (process.serviceName) {
    return `${process.type} · ${process.serviceName}`;
  }
  return process.type;
}

export function RuntimeMonitorBadge() {
  const { snapshot, error } = useElectronRuntimeStats();

  if (window.electronAPI?.isElectron !== true) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-grid w-[13rem] max-w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs text-foreground/85 transition hover:bg-background"
          aria-label="Runtime monitor"
        >
          <Activity className="h-3.5 w-3.5" />
          <span className="truncate text-left tabular-nums">
            {formatRuntimeSummary(snapshot)}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] space-y-2 p-3">
        <DropdownMenuLabel className="px-0">Runtime Monitor</DropdownMenuLabel>
        <RuntimeDetailRow
          label="Electron Total"
          cpuPercent={snapshot?.electron.totalCpuPercent ?? null}
          memoryMb={snapshot?.electron.totalMemoryMb ?? null}
        />
        <RuntimeDetailRow
          label="Local Backend"
          cpuPercent={snapshot?.backend.cpuPercent ?? null}
          memoryMb={snapshot?.backend.memoryMb ?? null}
        />
        <DropdownMenuSeparator />
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground/70">
            Electron Processes
          </p>
          <div className="space-y-1.5">
            {snapshot?.electron.processes.length ? (
              snapshot.electron.processes.map((process) => (
                <RuntimeDetailRow
                  key={`${process.pid}-${process.type}`}
                  label={renderProcessLabel(process)}
                  cpuPercent={process.cpuPercent}
                  memoryMb={process.memoryMb}
                />
              ))
            ) : (
              <p className="text-xs text-muted-foreground">Waiting for process metrics...</p>
            )}
          </div>
        </div>
        {snapshot ? (
          <p className="pt-1 text-[11px] text-muted-foreground/70">
            Updated {new Date(snapshot.sampledAt).toLocaleTimeString()}
          </p>
        ) : null}
        {error ? <p className="text-xs text-amber-600">{error}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
