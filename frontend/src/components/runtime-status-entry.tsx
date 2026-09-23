import { Activity, AlertTriangle } from "lucide-react";
import { useRuntimeStatus } from "../features/runtime-status/use-runtime-status";
import { cn } from "../lib/utils";
import { Tooltip } from "./ui/tooltip";

const STATE_TONE = {
  unhealthy: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-200",
  recovering:
    "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-200",
  checking: "border-border/70 bg-background/70 text-muted-foreground",
  blocked: "border-border/70 bg-muted/60 text-muted-foreground",
  healthy:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
  unconfigured: "border-border/70 bg-muted/60 text-muted-foreground",
  disabled: "border-border/70 bg-muted/60 text-muted-foreground",
  unsupported: "border-border/70 bg-muted/60 text-muted-foreground",
} as const;

export function RuntimeStatusEntry(props: {
  className?: string;
  iconOnly?: boolean;
}) {
  const {
    overallState,
    unhealthyCapabilityIds,
    warningCapabilityIds,
    panelOpen,
    setPanelOpen,
  } = useRuntimeStatus();
  const unhealthyCount = unhealthyCapabilityIds.length;
  const warningCount = warningCapabilityIds.length;
  const attention =
    unhealthyCount > 0 ? "error" : warningCount > 0 ? "warning" : "none";
  const tooltip = `运行状态${unhealthyCount ? ` · ${unhealthyCount} 个异常服务` : ""}${warningCount ? ` · ${warningCount} 个服务需关注` : ""}`;
  const tone =
    attention === "error"
      ? STATE_TONE.unhealthy
      : attention === "warning"
        ? STATE_TONE.recovering
        : STATE_TONE[overallState];

  const entry = (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs shadow-sm transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        props.iconOnly && "relative w-8 justify-center gap-0 rounded-md px-0",
        props.className,
        tone,
      )}
      data-runtime-status-state={overallState}
      data-runtime-status-attention={attention}
      aria-label={`${tooltip}，点击查看详情`}
      aria-haspopup="dialog"
      aria-expanded={panelOpen}
      title={props.iconOnly ? undefined : `${tooltip}，点击查看详情`}
      onClick={() => setPanelOpen(true)}
    >
      {attention !== "none" ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Activity className="h-3.5 w-3.5 shrink-0" />
      )}
      {props.iconOnly ? null : (
        <span>
          {attention === "error"
            ? "异常"
            : attention === "warning"
              ? "Warning"
              : "状态"}
        </span>
      )}
      {[
        {
          count: unhealthyCount,
          kind: "error",
          tone: "bg-red-600",
          label: "异常服务",
        },
        {
          count: warningCount,
          kind: "warning",
          tone: "bg-amber-600",
          label: "服务需关注",
        },
      ]
        .filter(({ count }) => count > 0)
        .map(({ count, kind, tone: badgeTone, label }, index) => (
          <span
            key={kind}
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white",
              badgeTone,
              props.iconOnly &&
                "absolute -right-1 flex h-3 min-w-3 items-center justify-center px-0.5 text-[8px] leading-none",
              props.iconOnly && (index === 0 ? "-top-1" : "-bottom-1"),
            )}
            aria-label={`${count} 个${label}`}
            data-runtime-status-badge={kind}
          >
            {count}
          </span>
        ))}
    </button>
  );

  return props.iconOnly ? (
    <Tooltip align="end" content={tooltip}>
      {entry}
    </Tooltip>
  ) : (
    entry
  );
}
