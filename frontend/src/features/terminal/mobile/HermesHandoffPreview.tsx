import { Clipboard, ExternalLink } from "lucide-react";
import type { MobileTerminalCardViewModel } from "./terminal-card-view-model";

interface HermesHandoffPreviewProps {
  terminal: MobileTerminalCardViewModel;
  copied: boolean;
  copyError: string | null;
  onCopy: () => Promise<void>;
  onCopyAndPromptFeishu: () => Promise<void>;
}

export function buildHermesContext(
  terminal: MobileTerminalCardViewModel,
): string {
  return [
    "Hermes，接管这个 Runweave 终端。",
    "",
    `项目：${terminal.projectName}`,
    `tmux session：${terminal.tmuxSessionName ?? `runweave-${terminal.terminalSessionId}`}`,
    `路径：${terminal.cwd ?? "未绑定路径"}`,
    `tmux socket：${terminal.tmuxSocketPath ?? "无"}`,
    "",
    "请根据以上信息,找到 tmux session 并发送如下消息:",
    "",
  ].join("\n");
}

export function HermesHandoffPreview({
  terminal,
  copied,
  copyError,
  onCopy,
  onCopyAndPromptFeishu,
}: HermesHandoffPreviewProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border/60 bg-card/70 p-3">
        <p className="text-xs font-semibold text-muted-foreground">
          上下文预览
        </p>
        <pre className="mt-2 max-h-[45dvh] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-foreground">
          {buildHermesContext(terminal)}
        </pre>
      </div>
      {copied ? (
        <div className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:border-emerald-800/80 dark:bg-emerald-950/45 dark:text-emerald-200">
          已复制，请打开飞书粘贴。
        </div>
      ) : null}
      {copyError ? (
        <div className="rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/45 dark:text-rose-200">
          {copyError}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-card/70 px-3 text-xs font-semibold text-foreground transition-colors hover:border-border"
          onClick={() => {
            void onCopy();
          }}
        >
          <Clipboard className="h-4 w-4" />
          仅复制
        </button>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => {
            void onCopyAndPromptFeishu();
          }}
        >
          <ExternalLink className="h-4 w-4" />
          复制并提示
        </button>
      </div>
    </div>
  );
}
