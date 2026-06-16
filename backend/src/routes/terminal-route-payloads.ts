import type {
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  TerminalState,
} from "@runweave/shared";
import type { TerminalSessionManager } from "../terminal/manager";

type TerminalProject = NonNullable<
  ReturnType<TerminalSessionManager["getProject"]>
>;

type TerminalSession = NonNullable<
  ReturnType<TerminalSessionManager["getSession"]>
>;

export function toProjectPayload(
  project: TerminalProject,
): TerminalProjectListItem {
  return {
    projectId: project.id,
    name: project.name,
    path: project.path ?? null,
    createdAt: project.createdAt.toISOString(),
    isDefault: project.isDefault,
  };
}

export function toStatusPayload(
  session: TerminalSession,
  scrollback = session.scrollback,
): TerminalSessionStatusResponse {
  return {
    terminalSessionId: session.id,
    projectId: session.projectId,
    alias: session.alias,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
    tmuxSessionName: session.tmuxSessionName,
    tmuxSocketPath: session.tmuxSocketPath,
    scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
  };
}

export function toSessionListItem(
  session: TerminalSession,
  terminalState?: TerminalState,
): TerminalSessionListItem {
  return {
    terminalSessionId: session.id,
    projectId: session.projectId,
    alias: session.alias,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
    ...(terminalState ? { terminalState } : {}),
    tmuxSessionName: session.tmuxSessionName,
    tmuxSocketPath: session.tmuxSocketPath,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
  };
}

export function toHistoryPayload(
  session: TerminalSession,
  scrollback: string,
  scrollbackSourceCols?: number,
): TerminalSessionHistoryResponse {
  return {
    ...toStatusPayload(session, scrollback),
    ...(scrollbackSourceCols ? { scrollbackSourceCols } : {}),
  };
}
