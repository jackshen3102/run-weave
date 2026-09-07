import { useMemoizedFn } from "ahooks";
import { Activity, Check, Copy } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { useRuntimeStatus } from "../features/runtime-status/use-runtime-status";
import { copyRuntimeStatusText } from "../features/runtime-status/copy";
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
  const { currentAddress, overallState, unhealthyCapabilityIds, setPanelOpen } =
    useRuntimeStatus();
  const [copied, setCopied] = useState(false);
  const copyAddress = useMemoizedFn(async (event: MouseEvent) => {
    event.stopPropagation();
    if (await copyRuntimeStatusText(currentAddress)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  });

  return (
    <div
      className={cn(
        "inline-flex h-8 max-w-[22rem] items-center overflow-hidden rounded-full border text-xs shadow-sm transition",
        STATE_TONE[overallState],
        props.className,
      )}
      data-runtime-status-state={overallState}
    >
      <button type="button" className="grid h-full w-8 shrink-0 place-items-center hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]" aria-label="打开运行状态" onClick={() => setPanelOpen(true)}>
        <Activity className="h-3.5 w-3.5 shrink-0" />
      </button>
      <button
        type="button"
        className="inline-flex h-full min-w-0 flex-1 items-center gap-2 border-l border-current/15 px-2 hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        aria-label="复制当前连接地址"
        title="复制当前连接地址"
        onClick={copyAddress}
      >
        <span className="min-w-0 truncate font-mono tabular-nums">
          {currentAddress}
        </span>
        {unhealthyCapabilityIds.length > 0 ? (
          <span
            className="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
            aria-label={`${unhealthyCapabilityIds.length} 个异常能力域`}
          >
            {unhealthyCapabilityIds.length}
          </span>
        ) : null}
        <span className="sr-only">{currentAddress}</span>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
