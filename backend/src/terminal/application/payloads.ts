import type {
  TerminalPanelListItem,
  TerminalPanelWorkspace,
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  TerminalState,
} from "@runweave/shared/terminal-protocol";
import { aggregateProgramStatus, type TerminalProgramStatus } from "@runweave/shared/terminal/program-status";
import type { TerminalSessionManager } from "../manager/manager";
import { resolveHostedAgentRecovery } from "../runtime/recovery-policy";
import { supportsHostedAgentRecovery } from "../runtime/pty-host-client";

type TerminalProject = NonNullable<
  ReturnType<TerminalSessionManager["getProject"]>
>;

type TerminalSession = NonNullable<
  ReturnType<TerminalSessionManager["getSession"]>
>;

type TerminalPanel = NonNullable<
  ReturnType<TerminalSessionManager["getPanel"]>
>;

function hookProgramStatus(state?: TerminalState, observedAt?: string): TerminalProgramStatus | undefined {
  if (!state || state.state === "shell_idle") return undefined;
  const value = { agent_starting: "starting", agent_running: "working", agent_idle: "idle" } as const;
  return { state: value[state.state], source: "hook", observedAt };
}

function sessionProgramStatus(session: TerminalSession, terminalState?: TerminalState) {
  return session.status === "running"
    ? session.oscProgramStatus ?? hookProgramStatus(terminalState)
    : undefined;
}

export function toDefaultPanelWorkspace(session: TerminalSession, terminalState = session.terminalState): TerminalPanelWorkspace {
  return {
    terminalSessionId: session.id,
    activePanelId: "default",
    panels: [{
      panelId: "default",
      terminalSessionId: session.id,
      alias: "main",
      role: "main",
      cwd: session.cwd,
      activeCommand: session.activeCommand,
      programStatus: sessionProgramStatus(session, terminalState),
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      exitCode: session.exitCode,
      focused: true,
    }],
    renderMode: "tmux-native",
  };
}

export function toProjectPayload(
  project: TerminalProject,
): TerminalProjectListItem {
  return {
    projectId: project.id,
    name: project.name,
    path: project.path ?? null,
    mainBranch: project.mainBranch ?? null,
    createdAt: project.createdAt.toISOString(),
    isDefault: project.isDefault,
  };
}

export function toStatusPayload(
  session: TerminalSession,
  scrollback = session.scrollback,
): TerminalSessionStatusResponse {
  return {
    source: session.source,
    terminalSessionId: session.id,
    projectId: session.projectId,
    alias: session.alias,
    threadId: session.threadId,
    threadProvider: session.threadProvider,
    preview: session.preview,
    lastThreadId: session.lastThreadId,
    lastThreadProvider: session.lastThreadProvider,
    lastThreadStatus: session.lastThreadStatus,
    lastThreadUpdatedAt: session.lastThreadUpdatedAt?.toISOString(),
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
  panelWorkspace?: TerminalPanelWorkspace | null,
): TerminalSessionListItem {
  const agentRecovery = supportsHostedAgentRecovery() ? resolveHostedAgentRecovery(session, terminalState) : null;
  const programStatus = session.status === "running"
    ? (panelWorkspace && aggregateProgramStatus(panelWorkspace.panels)) ?? sessionProgramStatus(session, terminalState)
    : undefined;
  return {
    ...(agentRecovery ? { agentRecovery } : {}),
    source: session.source,
    terminalSessionId: session.id,
    projectId: session.projectId,
    alias: session.alias,
    pinnedAt: session.pinnedAt ?? null,
    threadId: session.threadId,
    threadProvider: session.threadProvider,
    preview: session.preview,
    lastThreadId: session.lastThreadId,
    lastThreadProvider: session.lastThreadProvider,
    lastThreadStatus: session.lastThreadStatus,
    lastThreadUpdatedAt: session.lastThreadUpdatedAt?.toISOString(),
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
    ...(terminalState ? { terminalState } : {}),
    ...(programStatus ? { programStatus } : {}),
    completionRevision: session.completionRevision,
    acknowledgedCompletionRevision: session.acknowledgedCompletionRevision,
    tmuxSessionName: session.tmuxSessionName,
    tmuxSocketPath: session.tmuxSocketPath,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
    panelSplitEnabled: session.panelSplitEnabled,
    ...(panelWorkspace
      ? {
          activePanelId: panelWorkspace.activePanelId,
          panelCount: panelWorkspace.panels.length,
          panelAliases: panelWorkspace.panels
            .map((panel) => panel.alias)
            .filter((alias): alias is string => Boolean(alias)),
        }
      : {}),
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

export function toPanelListItem(
  panel: TerminalPanel,
  activePanelId: string | null,
): TerminalPanelListItem {
  const programStatus = panel.status === "running"
    ? panel.oscProgramStatus ?? hookProgramStatus(panel.terminalState, panel.lastThreadUpdatedAt?.toISOString())
    : undefined;
  return {
    codexContext: panel.codexContext,
    panelId: panel.id,
    terminalSessionId: panel.terminalSessionId,
    alias: panel.alias,
    role: panel.role,
    threadId: panel.threadId,
    threadProvider: panel.threadProvider,
    pi: panel.pi,
    preview: panel.preview,
    lastThreadId: panel.lastThreadId,
    lastThreadProvider: panel.lastThreadProvider,
    lastThreadStatus: panel.lastThreadStatus,
    lastThreadUpdatedAt: panel.lastThreadUpdatedAt?.toISOString(),
    cwd: panel.cwd,
    activeCommand: panel.activeCommand,
    ...(panel.terminalState ? { terminalState: panel.terminalState } : {}),
    ...(programStatus ? { programStatus } : {}),
    status: panel.status,
    createdAt: panel.createdAt.toISOString(),
    lastActivityAt: panel.lastActivityAt.toISOString(),
    exitCode: panel.exitCode,
    focused: panel.id === activePanelId,
    tmuxPaneId: panel.tmuxPaneId,
  };
}

export function toPanelWorkspacePayload(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
): TerminalPanelWorkspace | null {
  const workspace =
    terminalSessionManager.getPanelWorkspace(terminalSessionId) ?? null;
  if (!workspace) {
    return null;
  }
  return {
    terminalSessionId,
    activePanelId: workspace.activePanelId,
    panels: terminalSessionManager
      .listPanels(terminalSessionId)
      .map((panel) => toPanelListItem(panel, workspace.activePanelId)),
    renderMode: workspace.renderMode,
  };
}
