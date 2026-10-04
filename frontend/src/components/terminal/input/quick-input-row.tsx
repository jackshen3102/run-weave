import type { TerminalQuickInputItem } from "@runweave/shared/terminal/input";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  MoreHorizontal,
  Play,
  Send,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

export function TerminalQuickInputRow({
  item,
  busy,
  canTargetTerminal,
  canBackgroundRun,
  running,
  sorting,
  first,
  last,
  onSend,
  onInsert,
  onCopy,
  onEdit,
  onDelete,
  onBackgroundRun,
  onViewRun,
  onMove,
}: {
  item: TerminalQuickInputItem;
  busy: boolean;
  canTargetTerminal: boolean;
  canBackgroundRun: boolean;
  running: boolean;
  sorting: boolean;
  first: boolean;
  last: boolean;
  onSend: (item: TerminalQuickInputItem) => void;
  onInsert: (item: TerminalQuickInputItem) => void;
  onCopy: (item: TerminalQuickInputItem) => void;
  onEdit: (item: TerminalQuickInputItem) => void;
  onDelete: (item: TerminalQuickInputItem) => void;
  onBackgroundRun: (item: TerminalQuickInputItem) => void;
  onViewRun: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3"
      data-testid={`quick-command-${item.id}`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => onEdit(item)}
        aria-label={`查看全文 ${item.title}`}
      >
        <p className="truncate text-sm font-medium text-slate-100">
          {item.title}
        </p>
        <p className="mt-1 truncate text-xs text-slate-400">
          {item.data.replaceAll("\n", " ")}
        </p>
      </button>
      {sorting ? (
        <>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={busy || first}
            aria-label={`上移 ${item.title}`}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={busy || last}
            aria-label={`下移 ${item.title}`}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            disabled={busy || !canTargetTerminal}
            onClick={() => onSend(item)}
            aria-label={`发送到终端 ${item.title}`}
          >
            <Send className="h-3 w-3" />
            发送
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 border-sky-900 px-2 text-xs text-sky-300"
            disabled={busy || (!running && !canBackgroundRun)}
            onClick={() => (running ? onViewRun() : onBackgroundRun(item))}
            aria-label={`${running ? "查看运行" : "后台运行"} ${item.title}`}
          >
            {running ? (
              <Clock className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {running ? "查看" : "后台"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-6"
                disabled={busy}
                aria-label={`管理 ${item.title}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onEdit(item)}>
                查看全文 / 编辑
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canTargetTerminal || !canInsertRaw(item)}
                onSelect={() => onInsert(item)}
              >
                插入终端
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCopy(item)}>
                复制指令
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => onDelete(item)}
              >
                删除指令
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

export function canInsertRaw(item: TerminalQuickInputItem): boolean {
  return (
    (item.mode === "line" || item.mode === "codex_slash_command") &&
    !/[\n\r]/.test(item.data)
  );
}
export function buildQuickInputTitle(data: string): string {
  return (
    data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? data.trim()
  ).slice(0, 80);
}
