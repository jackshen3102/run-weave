import type { ReactNode } from "react";
import type { TerminalQuickInputItem } from "@runweave/shared/terminal/input";
import {
  Clipboard,
  CornerDownLeft,
  Pin,
  PinOff,
  Send,
  Trash2,
} from "lucide-react";

export function TerminalQuickInputRow({
  item,
  busy,
  canTargetTerminal,
  onSend,
  onInsert,
  onCopy,
  onTogglePinned,
  onDelete,
}: {
  item: TerminalQuickInputItem;
  busy: boolean;
  canTargetTerminal: boolean;
  onSend: (item: TerminalQuickInputItem) => Promise<void>;
  onInsert: (item: TerminalQuickInputItem) => Promise<void>;
  onCopy: (item: TerminalQuickInputItem) => Promise<void>;
  onTogglePinned: (item: TerminalQuickInputItem) => Promise<void>;
  onDelete: (item: TerminalQuickInputItem) => Promise<void>;
}) {
  const insertAllowed = canInsertRaw(item);
  const insertTitle = insertAllowed
    ? "插入"
    : item.mode === "prompt_paste"
      ? "长提示语请直接发送或复制"
      : "包含换行的输入请直接发送或复制";

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/70 p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-xs font-medium text-slate-100">
              {item.title || buildPreview(item.data)}
            </p>
            <span className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] leading-3 text-slate-400">
              {item.mode}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-slate-400">
            {buildPreview(item.data)}
          </p>
          <p className="mt-1 truncate text-[10px] text-slate-500">
            {formatSource(item)} ·{" "}
            {formatRelativeTime(item.lastUsedAt ?? item.updatedAt)}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <IconButton
            disabled={busy}
            title={item.pinned ? "取消固定" : "固定"}
            onClick={() => void onTogglePinned(item)}
          >
            {item.pinned ? (
              <PinOff className="h-3.5 w-3.5" />
            ) : (
              <Pin className="h-3.5 w-3.5" />
            )}
          </IconButton>
          <IconButton
            disabled={busy || !canTargetTerminal || !insertAllowed}
            title={insertTitle}
            onClick={() => void onInsert(item)}
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            disabled={busy}
            title="复制"
            onClick={() => void onCopy(item)}
          >
            <Clipboard className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            disabled={busy || !canTargetTerminal}
            title="发送"
            onClick={() => void onSend(item)}
          >
            <Send className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            disabled={busy}
            title="删除"
            onClick={() => void onDelete(item)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  children,
  disabled,
  title,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={title}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function canInsertRaw(item: TerminalQuickInputItem): boolean {
  return (
    (item.mode === "line" || item.mode === "codex_slash_command") &&
    !item.data.includes("\n") &&
    !item.data.includes("\r")
  );
}

function buildPreview(data: string): string {
  return data.trim() || "(empty)";
}

export function buildQuickInputTitle(data: string): string {
  const firstLine = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? data.trim();
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function formatSource(item: TerminalQuickInputItem): string {
  if (item.source === "web_git_submit") {
    return "提交提示";
  }
  if (item.source === "web_browser_annotation") {
    return "Browser";
  }
  if (item.projectId) {
    return "current project";
  }
  return "全局";
}

function formatRelativeTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "just now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${Math.floor(diffHours / 24)}d ago`;
}
