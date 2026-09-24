import { useOpenCodexQuota } from "../features/codex-quota/context";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { AttentionSlot } from "@runweave/shared/attention";
import { useOpenMobileLogin } from "../features/mobile-login/context";
import { Check, ChevronsUpDown, PlusCircle } from "lucide-react";
import type { ConnectionConfig } from "../features/connection/types";
import { useConnectionWorkspaceOverview } from "../features/connection/workspace-overview";
import { useProjectBindings } from "../features/connection/project-bindings";
import { buildConnectionQueryScope } from "../features/query/connection-query-provider";
import { setTerminalNavigation } from "../features/terminal/state/navigation";
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
  currentProjects?: TerminalProjectListItem[];
  currentSessions?: TerminalSessionListItem[];
  onSelectProject?: (projectId: string) => void;
  className?: string;
}

export function ConnectionSwitcher({
  connections,
  activeConnectionId,
  activeConnectionName,
  onSelectConnection,
  onOpenConnectionManager,
  currentProjects = [],
  currentSessions = [],
  onSelectProject,
  className,
}: ConnectionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const overviews = useConnectionWorkspaceOverview((state) => state.byConnectionId);
  const bindings = useProjectBindings((state) => state.bindings);
  const openMobileLogin = useOpenMobileLogin();
  const openCodexQuota = useOpenCodexQuota();
  const resolvedActiveName =
    activeConnectionName ??
    connections.find((connection) => connection.id === activeConnectionId)?.name ??
    "未选择连接";

  const openAttention = (connection: ConnectionConfig, slot: AttentionSlot) => {
    setTerminalNavigation(buildConnectionQueryScope({ apiBase: connection.url, connectionId: connection.id, generation: connection.kind === "ssh" ? connection.generation : undefined }), {
      parentProjectId: slot.parentProjectId,
      projectId: slot.projectId,
      terminalSessionId: slot.terminalSessionId,
      ...(slot.panelId ? { panelId: slot.panelId } : {}),
    });
    if (connection.id !== activeConnectionId) onSelectConnection(connection.id);
    navigate(`/terminal/${encodeURIComponent(slot.terminalSessionId)}`);
    setOpen(false);
  };

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
          const overview = overviews[connection.id];
          const allProjects = isActive ? currentProjects : overview?.projects ?? [];
          const projects = connection.kind === "ssh"
            ? allProjects.filter((project) => bindings.some((binding) => binding.connectionId === connection.id && binding.remoteProjectId === project.projectId))
            : allProjects;
          const sessions = isActive ? currentSessions : overview?.sessions ?? [];
          const live = connection.available !== false && (isActive || overview?.status === "ready");
          const attention = live ? overview?.attention?.slots.filter((slot) => slot.state === "needs_action" || slot.state === "blocked" || slot.state === "failed") ?? [] : [];

          return (
            <div key={connection.id}>
            <DropdownMenuItem onSelect={() => { onSelectConnection(connection.id); setOpen(false); }} className="items-start">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{connection.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {live ? `${projects.length} 个项目 · ${sessions.length} 个终端${attention.length ? ` · ${attention.length} 项待处理` : ""}` : `连接中断${overview?.observedAt ? `，最后更新于 ${new Date(overview.observedAt).toLocaleString()}` : ""}`}
                </span>
              </div>
              {isActive ? <Check className="mt-0.5 h-4 w-4 text-primary" /> : null}
            </DropdownMenuItem>
            {projects.map((project) => {
              const projectSessions = sessions.filter((session) => session.projectId === project.projectId);
              const running = projectSessions.filter((session) => session.terminalState?.state === "agent_running").length;
              return <DropdownMenuItem key={`${connection.id}:${project.projectId}`} disabled={!live} className="pl-6" onSelect={() => {
                if (isActive) {
                  onSelectProject?.(project.projectId);
                } else {
                  setTerminalNavigation(buildConnectionQueryScope({ apiBase: connection.url, connectionId: connection.id, generation: connection.kind === "ssh" ? connection.generation : undefined }), {
                    parentProjectId: project.projectId,
                    projectId: project.projectId,
                    terminalSessionId: null,
                  });
                  onSelectConnection(connection.id);
                  navigate("/terminal");
                }
                setOpen(false);
              }}>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="text-xs text-muted-foreground">{live ? `${running} 工作中 / ${projectSessions.length} 终端` : "历史状态"}</span>
              </DropdownMenuItem>;
            })}
            {attention.filter((slot) => connection.kind !== "ssh" || bindings.some((binding) => binding.connectionId === connection.id && binding.remoteProjectId === slot.parentProjectId)).map((slot) => (
              <DropdownMenuItem key={`${connection.id}:${slot.attentionId}`} className="pl-6" onSelect={() => openAttention(connection, slot)}>
                <span className="min-w-0 flex-1 truncate text-amber-600">{slot.projectName} · {slot.title}</span>
              </DropdownMenuItem>
            ))}
            </div>
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
