import { useMemoizedFn } from "ahooks";
import { CornerUpLeft } from "lucide-react";
import {
  parseTerminalChildProjectId,
  resolveTerminalParentProjectId,
} from "@runweave/shared/terminal/project-context";
import type {
  TerminalOriginSource,
  TerminalSessionSource,
  TerminalSourceRelation,
} from "@runweave/shared/terminal/session";
import { ScheduledTaskSourceLink } from "../../../features/scheduled-tasks/source-link";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
} from "../../../features/terminal/queries/workspace";
import { formatTerminalSessionName } from "../../../features/terminal/state/session-name";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";

const RELATION_LABELS: Record<TerminalSourceRelation, string> = {
  "code-review": "代码 Review",
  "context-handoff": "换 Agent 交接",
  "agent-fork": "Fork 会话",
  task: "任务终端",
};

function TerminalOriginSourceLink({ source }: { source: TerminalOriginSource }) {
  const projects = useTerminalProjectsQuery().data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const origin =
    sessions.find((item) => item.terminalSessionId === source.terminalSessionId) ??
    null;
  const relationLabel = source.relation ? RELATION_LABELS[source.relation] : null;

  const openOrigin = useMemoizedFn(() => {
    if (!origin) return;
    useTerminalWorkspaceStore
      .getState()
      .selectProjectContext(
        resolveTerminalParentProjectId(origin.projectId),
        origin.projectId,
        origin.terminalSessionId,
      );
  });

  if (!origin) {
    return (
      <button
        type="button"
        disabled
        data-testid="terminal-source-link"
        className="inline-flex max-w-48 shrink-0 cursor-not-allowed items-center gap-1 rounded px-2 py-1 text-xs text-slate-500"
        title={relationLabel ? `原终端已关闭（${relationLabel}）` : "原终端已关闭"}
      >
        <CornerUpLeft className="h-3 w-3 shrink-0" />
        <span className="truncate">来源：原终端已关闭</span>
      </button>
    );
  }

  const originName = formatTerminalSessionName(origin);
  const parentProjectId = resolveTerminalParentProjectId(origin.projectId);
  const projectName = projects.find(
    (project) => project.projectId === parentProjectId,
  )?.name;
  const worktreeName = parseTerminalChildProjectId(origin.projectId)?.worktreeName;
  const location = [projectName, worktreeName, originName]
    .filter(Boolean)
    .join(" / ");

  return (
    <button
      type="button"
      data-testid="terminal-source-link"
      className="inline-flex max-w-48 shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
      title={
        relationLabel
          ? `返回来源终端（${relationLabel}）：${location}`
          : `返回来源终端：${location}`
      }
      onClick={openOrigin}
    >
      <CornerUpLeft className="h-3 w-3 shrink-0" />
      <span className="truncate">来源：{originName}</span>
    </button>
  );
}

export function TerminalSourceLink({
  source,
}: {
  source: TerminalSessionSource;
}) {
  if (source.type === "scheduled-task") {
    return <ScheduledTaskSourceLink source={source} />;
  }
  return <TerminalOriginSourceLink source={source} />;
}
