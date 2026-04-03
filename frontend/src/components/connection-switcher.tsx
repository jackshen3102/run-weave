import { useState } from "react";
import { Check, ChevronsUpDown, PlusCircle } from "lucide-react";
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
          className={className ?? "rounded-full border border-border/60 bg-background/60 px-3 text-[0.72rem] text-muted-foreground backdrop-blur"}
        >
          <span className="mr-2 text-[0.62rem] uppercase tracking-[0.24em] text-muted-foreground/70">
            当前连接
          </span>
          <span className="max-w-[14rem] truncate">{resolvedActiveName}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[18rem]">
        <DropdownMenuLabel>切换连接</DropdownMenuLabel>
        {connections.map((connection) => {
          const isActive = connection.id === activeConnectionId;

          return (
            <DropdownMenuItem
              key={connection.id}
              onSelect={() => {
                onSelectConnection(connection.id);
                setOpen(false);
              }}
              className="items-start"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{connection.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {connection.url}
                </span>
              </div>
              {isActive ? <Check className="mt-0.5 h-4 w-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
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
