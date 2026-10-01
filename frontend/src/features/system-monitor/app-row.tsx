import { useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  SystemMonitorAppGroup,
  SystemMonitorProcess,
} from "@runweave/shared/system-monitor";
import type { TerminateProcessResult } from "@runweave/shared/resource-monitor";
import { Button } from "../../components/ui/button";
import { formatMemory, formatPercent } from "./format";
export type SortKey = "energy" | "cpu" | "memory";

function processDisplayName(process: SystemMonitorProcess): string {
  const displayName = process.displayName.trim();
  if (displayName.length <= 72) {
    return displayName;
  }
  return `${displayName.slice(0, 69)}...`;
}

export function AppRow(params: {
  app: SystemMonitorAppGroup;
  processes: SystemMonitorProcess[];
  expanded: boolean;
  sortKey: SortKey;
  onToggle: () => void;
  onTerminate: (process: SystemMonitorProcess, force: boolean) => void;
  results: Record<string, TerminateProcessResult | string>;
  pending: string | null;
  canTerminate: boolean;
}) {
  const sortedProcesses = useMemo(() => {
    return [...params.processes].sort((a, b) => {
      const primary =
        params.sortKey === "energy"
          ? (b.energyImpact ?? -1) - (a.energyImpact ?? -1)
          : params.sortKey === "cpu"
            ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)
            : b.memoryMb - a.memoryMb;
      return (
        primary ||
        (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) ||
        b.memoryMb - a.memoryMb
      );
    });
  }, [params.processes, params.sortKey]);

  return (
    <>
      <tr
        id={`resource-app-${params.app.appKey}`}
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
          {params.app.energyImpact == null
            ? "—"
            : params.app.energyImpact.toFixed(1)}
          {params.app.coverage === "partial" ? (
            <span className="block text-[10px] text-muted-foreground">
              覆盖不完整
            </span>
          ) : null}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatPercent(
            params.app.coverage === "partial" ? null : params.app.cpuPercent,
          )}
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
            colSpan={5}
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
                        RSS
                      </th>
                      <th className="w-40 px-3 py-2 text-right font-medium">
                        操作
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
                          {formatPercent(
                            process.coverage === "partial"
                              ? null
                              : process.cpuPercent,
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMemory(process.memoryMb)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {(() => {
                            const id =
                              process.processInstanceId ?? String(process.pid);
                            const result = params.results[id];
                            const finished =
                              typeof result === "object" &&
                              result.state !== "still_running";
                            return (
                              <div className="flex flex-col items-end gap-1">
                                {result ? (
                                  <span
                                    role="status"
                                    className={
                                      finished
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-muted-foreground"
                                    }
                                  >
                                    {typeof result === "string"
                                      ? result
                                      : result.state === "still_running"
                                        ? "仍在运行"
                                        : result.state === "already_exited"
                                          ? "进程已退出"
                                          : "已结束"}
                                  </span>
                                ) : null}
                                {!finished ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs disabled:text-muted-foreground"
                                    title={process.actionReason}
                                    disabled={
                                      !!params.pending ||
                                      !params.canTerminate ||
                                      !process.processInstanceId ||
                                      process.actionKind === "readonly"
                                    }
                                    onClick={() =>
                                      params.onTerminate(
                                        process,
                                        typeof result === "object" &&
                                          result.forceAllowed,
                                      )
                                    }
                                  >
                                    {params.pending === id
                                      ? "正在结束…"
                                      : process.actionKind === "readonly"
                                        ? "受保护"
                                        : typeof result === "object" &&
                                            result.forceAllowed
                                          ? "强制结束…"
                                          : process.actionKind ===
                                              "stop_service"
                                            ? "停止服务"
                                            : "结束进程"}
                                  </Button>
                                ) : null}
                                {process.actionKind === "readonly" ? (
                                  <span className="text-[10px] text-muted-foreground">
                                    {process.actionReason}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })()}
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
