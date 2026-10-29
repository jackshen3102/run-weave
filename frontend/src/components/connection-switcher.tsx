import { useOpenCodexQuota } from "../features/codex-quota/context";
import { useState } from "react";
import { useOpenMobileLogin } from "../features/mobile-login/context";
import { Check, ChevronsUpDown, Monitor, PlusCircle } from "lucide-react";
import { useConnectionCompletionCounts } from "../features/connection/completion-counts";
import type { ConnectionConfig } from "../features/connection/types";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface ConnectionSwitcherProps {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  activeConnectionName?: string;
  onSelectConnection: (connectionId: string) => void;
  onOpenConnectionManager: () => void;
  className?: string;
}

export function ConnectionSwitcher({
  connections,
  activeConnectionId,
  activeConnectionName,
  onSelectConnection,
  onOpenConnectionManager,
  className,
}: ConnectionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const completions = useConnectionCompletionCounts(connections, activeConnectionId);
  const openMobileLogin = useOpenMobileLogin();
  const openCodexQuota = useOpenCodexQuota();
  const resolvedActiveName =
    activeConnectionName ??
    connections.find((connection) => connection.id === activeConnectionId)?.name ??
    "未选择连接";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((currentOpen) => !currentOpen)}
          className={`relative overflow-visible ${className ?? "rounded-full border border-border/60 bg-background/60 px-3 text-[0.72rem] text-muted-foreground backdrop-blur"}`}
        >
          <span className="mr-2 text-[0.62rem] uppercase tracking-[0.24em] text-muted-foreground/70">
            当前连接
          </span>
          <span className="max-w-[14rem] truncate">{resolvedActiveName}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-70" />
          {completions.otherTotal > 0 ? <span
            className="absolute -right-1.5 -top-1 inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full border-2 border-background bg-[#30d158] px-1 text-[11px] font-bold leading-none text-[#07140a] tabular-nums"
            aria-label={`其他连接 ${completions.otherTotal} 个未读完成终端`}
            data-testid="connection-completion-total"
          >{completions.otherTotal}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[18rem]">
        <DropdownMenuLabel>切换连接</DropdownMenuLabel>
        {connections.map((connection) => {
          const isActive = connection.id === activeConnectionId;
          const completion = completions.byId[connection.id];

          return (
            <DropdownMenuItem
              key={connection.id}
              className={isActive ? "bg-slate-800/80" : undefined}
              onSelect={() => { onSelectConnection(connection.id); setOpen(false); }}
            >
              <Monitor className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 py-1">
                <span className="block truncate font-medium">{connection.name}</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {isActive ? "当前连接" : completion?.stale || connection.available === false ? "离线 · 上次同步" : completion ? "已连接" : "尚未检测"}
                </span>
              </span>
              {completion && completion.count > 0 ? <span
                className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-[#30d158] px-1 text-[11px] font-bold leading-none text-[#07140a] tabular-nums"
                aria-label={`${connection.name} ${completion.count} 个未读完成终端`}
                title={completion.stale ? "离线 · 上次同步" : undefined}
                data-testid="connection-completion-count"
              >{completion.count}</span> : null}
              {isActive ? <Check className="h-4 w-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {openCodexQuota ? <DropdownMenuItem onSelect={() => { setOpen(false); openCodexQuota(); }}>Codex 额度</DropdownMenuItem> : null}
        {openMobileLogin ? <DropdownMenuItem onSelect={() => { setOpen(false); openMobileLogin(); }}>
          连接手机
        </DropdownMenuItem> : null}
        <DropdownMenuItem
          onSelect={() => {
            onOpenConnectionManager();
            setOpen(false);
          }}
        >
          <PlusCircle className="h-4 w-4 text-primary" />
          <span>连接管理</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
