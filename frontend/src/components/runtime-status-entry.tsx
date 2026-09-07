import { Activity } from "lucide-react";
import { useRuntimeStatus } from "../features/runtime-status/use-runtime-status";
import { cn } from "../lib/utils";

const STATE_TONE = {
  unhealthy: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-200",
  recovering: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-200",
  checking: "border-border/70 bg-background/70 text-muted-foreground",
  blocked: "border-border/70 bg-muted/60 text-muted-foreground",
  healthy: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
  unconfigured: "border-border/70 bg-muted/60 text-muted-foreground",
  disabled: "border-border/70 bg-muted/60 text-muted-foreground",
  unsupported: "border-border/70 bg-muted/60 text-muted-foreground",
} as const;

export function RuntimeStatusEntry(props: { className?: string }) {
  const { overallState, unhealthyCapabilityIds, panelOpen, setPanelOpen } =
    useRuntimeStatus();

  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs shadow-sm transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        STATE_TONE[overallState],
        props.className,
      )}
      data-runtime-status-state={overallState}
      aria-label="打开运行状态"
      aria-haspopup="dialog"
      aria-expanded={panelOpen}
      title="运行状态"
      onClick={() => setPanelOpen(true)}
    >
      <Activity className="h-3.5 w-3.5 shrink-0" />
      <span>状态</span>
      {unhealthyCapabilityIds.length > 0 ? (
        <span
          className="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
          aria-label={`${unhealthyCapabilityIds.length} 个异常能力域`}
        >
          {unhealthyCapabilityIds.length}
        </span>
      ) : null}
    </button>
  );
}
