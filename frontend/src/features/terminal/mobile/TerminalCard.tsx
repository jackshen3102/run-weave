import { useState } from "react";
import {
  Check,
  Clipboard,
  Eye,
  MessageSquare,
  Send,
  Terminal,
} from "lucide-react";
import type { MobileTerminalCardViewModel } from "./terminal-card-view-model";

const STATUS_CLASSES = {
  green:
    "border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-800/80 dark:bg-emerald-950/45 dark:text-emerald-200",
  blue: "border-sky-300/70 bg-sky-50 text-sky-700 dark:border-sky-800/80 dark:bg-sky-950/45 dark:text-sky-200",
  yellow:
    "border-amber-300/70 bg-amber-50 text-amber-800 dark:border-amber-800/80 dark:bg-amber-950/45 dark:text-amber-200",
  red: "border-rose-300/70 bg-rose-50 text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/45 dark:text-rose-200",
  gray: "border-border/70 bg-muted/60 text-muted-foreground",
} as const;

interface TerminalCardProps {
  terminal: MobileTerminalCardViewModel;
  onOpenDetail: (terminal: MobileTerminalCardViewModel) => void;
  onOpenHandoff: (terminal: MobileTerminalCardViewModel) => void;
  onCopyContext: (terminal: MobileTerminalCardViewModel) => Promise<void>;
}

function primaryActionLabel(
  action: MobileTerminalCardViewModel["primaryAction"],
): string {
  if (action === "observe") {
    return "观察";
  }
  if (action === "run_command") {
    return "运行命令";
  }
  if (action === "summarize") {
    return "总结终端";
  }
  return "发给 Hermes";
}

function PrimaryActionIcon({
  action,
}: {
  action: MobileTerminalCardViewModel["primaryAction"];
}) {
  if (action === "observe") {
    return <Eye className="h-4 w-4" />;
  }
  if (action === "summarize") {
    return <MessageSquare className="h-4 w-4" />;
  }
  if (action === "run_command") {
    return <Terminal className="h-4 w-4" />;
  }
  return <Send className="h-4 w-4" />;
}

export function TerminalCard({
  terminal,
  onOpenDetail,
  onOpenHandoff,
  onCopyContext,
}: TerminalCardProps) {
  const [contextCopied, setContextCopied] = useState(false);
  const primaryLabel = primaryActionLabel(terminal.primaryAction);
  const primaryHandler =
    terminal.primaryAction === "observe"
      ? () => {
          onOpenDetail(terminal);
        }
      : () => {
          onOpenHandoff(terminal);
        };
  const copyContext = async (): Promise<void> => {
    try {
      await onCopyContext(terminal);
      setContextCopied(true);
      window.setTimeout(() => {
        setContextCopied(false);
      }, 1600);
    } catch {
      setContextCopied(false);
    }
  };

  return (
    <article className="rounded-xl border border-border/60 bg-card/82 p-4 shadow-[0_16px_48px_-34px_rgba(15,23,42,0.76)] backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={[
                "inline-flex h-6 max-w-full items-center rounded-full border px-2 text-xs font-semibold",
                STATUS_CLASSES[terminal.statusColor],
              ].join(" ")}
            >
              <span className="truncate">{terminal.statusLabel}</span>
            </span>
          </div>
        </div>
        <span className="shrink-0 rounded-md border border-border/60 bg-background/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {terminal.shortId}
        </span>
      </div>

      <div className="mt-3 flex h-36 flex-col justify-end overflow-hidden rounded-lg border border-slate-900/10 bg-slate-950 p-3 dark:border-white/10 dark:bg-black/40">
        <pre className="shrink-0 whitespace-pre-wrap font-mono text-[11px] leading-4 text-slate-100">
          {terminal.tailPreview || "暂无 tail"}
        </pre>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={primaryHandler}
          title={primaryLabel}
        >
          <PrimaryActionIcon action={terminal.primaryAction} />
          <span className="truncate">{primaryLabel}</span>
        </button>
        <button
          type="button"
          className="inline-flex h-9 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/62 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            onOpenDetail(terminal);
          }}
          title="查看详情"
          aria-label="查看详情"
        >
          <Eye className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={[
            "inline-flex h-9 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/62 transition-colors hover:text-foreground",
            contextCopied ? "text-emerald-500" : "text-muted-foreground",
          ].join(" ")}
          onClick={() => {
            void copyContext();
          }}
          title={contextCopied ? "已复制上下文" : "复制上下文"}
          aria-label={contextCopied ? "已复制上下文" : "复制上下文"}
        >
          {contextCopied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Clipboard className="h-4 w-4" />
          )}
        </button>
      </div>
    </article>
  );
}
