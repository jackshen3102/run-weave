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
  const { overallState, unhealthyCapabilityIds, panelOpen, setPanelOpen } =
    useRuntimeStatus();
  const unhealthyCount = unhealthyCapabilityIds.length;
  const tooltip =
    overallState === "unhealthy"
      ? `运行状态 · ${unhealthyCount} 个异常能力域`
      : "运行状态";

  const entry = (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs shadow-sm transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        STATE_TONE[overallState],
        props.iconOnly && "relative w-8 justify-center gap-0 rounded-md px-0",
        props.className,
      )}
      data-runtime-status-state={overallState}
      aria-label={props.iconOnly ? `${tooltip}，点击查看详情` : "打开运行状态"}
      aria-haspopup="dialog"
      aria-expanded={panelOpen}
      title={
        props.iconOnly
          ? undefined
          : overallState === "unhealthy"
            ? "运行异常，点击查看详情"
            : "运行状态"
      }
      onClick={() => setPanelOpen(true)}
    >
      {overallState === "unhealthy" ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Activity className="h-3.5 w-3.5 shrink-0" />
      )}
      {props.iconOnly ? null : (
        <span>{overallState === "unhealthy" ? "异常" : "状态"}</span>
      )}
      {unhealthyCount > 0 ? (
        <span
          className={cn(
            "shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white",
            props.iconOnly &&
              "absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center px-0.5 text-[8px] leading-none",
          )}
          aria-label={`${unhealthyCount} 个异常能力域`}
        >
          {unhealthyCount}
        </span>
      ) : null}
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
