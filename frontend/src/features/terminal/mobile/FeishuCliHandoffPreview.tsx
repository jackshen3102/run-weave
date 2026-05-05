import { Clipboard, Send } from "lucide-react";
import type { MobileTerminalCardViewModel } from "./terminal-card-view-model";

interface FeishuCliHandoffPreviewProps {
  terminal: MobileTerminalCardViewModel;
  message: string;
  copied: boolean;
  copyError: string | null;
  onMessageChange: (message: string) => void;
  onCopy: () => Promise<void>;
  onCopyAndPromptFeishu: () => Promise<void>;
}

export const DEFAULT_FEISHU_TERMINAL_MESSAGE = "继续";

export function buildFeishuCliContext(
  terminal: MobileTerminalCardViewModel,
  message: string = DEFAULT_FEISHU_TERMINAL_MESSAGE,
): string {
  const terminalMessage = message.trim() || DEFAULT_FEISHU_TERMINAL_MESSAGE;

  return [
    "请用 Runweave CLI 继续这个终端对话。",
    "",
    `项目：${terminal.projectName}`,
    `终端 ID：${terminal.terminalSessionId}`,
    `路径：${terminal.cwd ?? "未绑定路径"}`,
    "",
    "要发送给终端的内容：",
    terminalMessage,
  ].join("\n");
}

export function FeishuCliHandoffPreview({
  terminal,
  message,
  copied,
  copyError,
  onMessageChange,
  onCopy,
  onCopyAndPromptFeishu,
}: FeishuCliHandoffPreviewProps) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          要发送的内容
        </span>
        <textarea
          className="min-h-24 resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          value={message}
          onChange={(event) => {
            onMessageChange(event.target.value);
          }}
        />
      </label>
      <div className="rounded-xl border border-border/60 bg-card/70 p-3">
        <p className="text-xs font-semibold text-muted-foreground">
          飞书粘贴内容
        </p>
        <pre className="mt-2 max-h-[45dvh] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-foreground">
          {buildFeishuCliContext(terminal, message)}
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
          <Send className="h-4 w-4" />
          复制到飞书
        </button>
      </div>
    </div>
  );
}
