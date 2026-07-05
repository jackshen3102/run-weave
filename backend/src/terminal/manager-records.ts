import type { TerminalLastThreadStatus, TerminalState } from "@runweave/shared";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalPanelRecord,
  PersistedTerminalPanelWorkspaceRecord,
  PersistedTerminalSessionMetadataRecord,
  PersistedTerminalSessionRecord,
  TerminalRuntimeKind,
} from "./store";
import {
  createScrollbackBuffer,
  readScrollbackBuffer,
  type ScrollbackBuffer,
} from "./scrollback-buffer";

export interface TerminalProjectRecord {
  id: string;
  name: string;
  path: string | null;
  createdAt: Date;
  isDefault: boolean;
  order?: number;
}

export interface TerminalSessionRecord {
  id: string;
  projectId: string;
  alias: string | null;
  threadId?: string;
  preview?: string;
  lastThreadId?: string;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: Date;
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  lastActivityAt: Date;
  exitCode?: number;
  order?: number;
  runtimeKind: TerminalRuntimeKind;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  tmuxUnavailableReason?: string;
  recoverable?: boolean;
  terminalState?: TerminalState;
  panelSplitEnabled: boolean;
}

export interface TerminalPanelRecord {
  id: string;
  terminalSessionId: string;
  alias: string | null;
  role: string | null;
  threadId?: string;
  preview?: string;
  lastThreadId?: string;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: Date;
  agentTeamRunId: string | null;
  agentTeamWorkerId: string | null;
  cwd: string;
  activeCommand: string | null;
  terminalState?: TerminalState;
  status: "running" | "exited";
  createdAt: Date;
  lastActivityAt: Date;
  exitCode?: number;
  runtimeKind: "tmux";
  tmuxPaneId: string;
}

export interface TerminalPanelWorkspaceRecord {
  terminalSessionId: string;
  activePanelId: string;
  panelIds: string[];
  renderMode: "tmux-native";
}

export interface RuntimeTerminalSessionRecord extends Omit<
  TerminalSessionRecord,
  "scrollback"
> {
  readonly scrollback: string;
  scrollbackBuffer: ScrollbackBuffer;
  scrollbackLoaded: boolean;
}

export interface CreateTerminalSessionOptions {
  projectId?: string;
  command: string;
  args?: string[];
  cwd: string;
}

export function buildProjectRecord(
  persisted: PersistedTerminalProjectRecord,
): TerminalProjectRecord {
  return {
    id: persisted.id,
    name: persisted.name,
    path: persisted.path ?? null,
    createdAt: new Date(persisted.createdAt),
    isDefault: persisted.isDefault,
    ...(persisted.order !== undefined ? { order: persisted.order } : {}),
  };
}

export function toPersistedProject(
  project: TerminalProjectRecord,
): PersistedTerminalProjectRecord {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    createdAt: project.createdAt.toISOString(),
    isDefault: project.isDefault,
  };
}

export function buildSessionRecord(
  persisted: PersistedTerminalSessionMetadataRecord & { scrollback?: string },
): TerminalSessionRecord {
  return {
    id: persisted.id,
    projectId: persisted.projectId,
    alias: persisted.alias ?? null,
    threadId: persisted.threadId,
    preview: persisted.preview,
    lastThreadId: persisted.lastThreadId,
    lastThreadStatus: persisted.lastThreadStatus,
    ...(persisted.lastThreadUpdatedAt
      ? { lastThreadUpdatedAt: new Date(persisted.lastThreadUpdatedAt) }
      : {}),
    command: persisted.command,
    args: persisted.args,
    cwd: persisted.cwd,
    activeCommand: persisted.activeCommand ?? null,
    scrollback: persisted.scrollback ?? "",
    status: persisted.status,
    createdAt: new Date(persisted.createdAt),
    lastActivityAt: new Date(persisted.lastActivityAt ?? persisted.createdAt),
    exitCode: persisted.exitCode,
    ...(persisted.order !== undefined ? { order: persisted.order } : {}),
    runtimeKind: persisted.runtimeKind ?? "pty",
    tmuxSessionName: persisted.tmuxSessionName,
    tmuxSocketPath: persisted.tmuxSocketPath,
    tmuxUnavailableReason: persisted.tmuxUnavailableReason,
    recoverable: persisted.recoverable,
    ...(persisted.terminalState !== undefined
      ? { terminalState: persisted.terminalState }
      : {}),
    panelSplitEnabled: persisted.panelSplitEnabled ?? false,
  };
}

export function createRuntimeRecord(
  record: TerminalSessionRecord,
  options?: { scrollbackLoaded?: boolean },
): RuntimeTerminalSessionRecord {
  const { scrollback, ...rest } = record;
  const runtimeRecord = { ...rest } as Omit<
    RuntimeTerminalSessionRecord,
    "scrollback" | "scrollbackBuffer"
  > &
    Partial<Pick<RuntimeTerminalSessionRecord, "scrollbackBuffer">>;

  Object.defineProperty(runtimeRecord, "scrollbackBuffer", {
    configurable: false,
    enumerable: false,
    value: createScrollbackBuffer(scrollback),
    writable: true,
  });
  Object.defineProperty(runtimeRecord, "scrollbackLoaded", {
    configurable: false,
    enumerable: false,
    value: options?.scrollbackLoaded ?? true,
    writable: true,
  });

  Object.defineProperty(runtimeRecord, "scrollback", {
    configurable: false,
    enumerable: true,
    get() {
      return readScrollbackBuffer(runtimeRecord.scrollbackBuffer!);
    },
  });

  return runtimeRecord as RuntimeTerminalSessionRecord;
}

export function toPersistedSession(
  session: TerminalSessionRecord,
): PersistedTerminalSessionRecord {
  return {
    id: session.id,
    projectId: session.projectId,
    alias: session.alias,
    threadId: session.threadId,
    preview: session.preview,
    lastThreadId: session.lastThreadId,
    lastThreadStatus: session.lastThreadStatus,
    ...(session.lastThreadUpdatedAt
      ? { lastThreadUpdatedAt: session.lastThreadUpdatedAt.toISOString() }
      : {}),
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
    scrollback: session.scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
    runtimeKind: session.runtimeKind,
    tmuxSessionName: session.tmuxSessionName,
    tmuxSocketPath: session.tmuxSocketPath,
    tmuxUnavailableReason: session.tmuxUnavailableReason,
    recoverable: session.recoverable,
    ...(session.terminalState !== undefined
      ? { terminalState: session.terminalState }
      : {}),
    panelSplitEnabled: session.panelSplitEnabled,
  };
}

export function buildPanelRecord(
  persisted: PersistedTerminalPanelRecord,
): TerminalPanelRecord {
  return {
    id: persisted.id,
    terminalSessionId: persisted.terminalSessionId,
    alias: persisted.alias ?? null,
    role: persisted.role ?? null,
    threadId: persisted.threadId,
    preview: persisted.preview,
    lastThreadId: persisted.lastThreadId,
    lastThreadStatus: persisted.lastThreadStatus,
    ...(persisted.lastThreadUpdatedAt
      ? { lastThreadUpdatedAt: new Date(persisted.lastThreadUpdatedAt) }
      : {}),
    agentTeamRunId: persisted.agentTeamRunId ?? null,
    agentTeamWorkerId: persisted.agentTeamWorkerId ?? null,
    cwd: persisted.cwd,
    activeCommand: persisted.activeCommand ?? null,
    ...(persisted.terminalState !== undefined
      ? { terminalState: persisted.terminalState }
      : {}),
    status: persisted.status,
    createdAt: new Date(persisted.createdAt),
    lastActivityAt: new Date(persisted.lastActivityAt),
    exitCode: persisted.exitCode,
    runtimeKind: persisted.runtimeKind,
    tmuxPaneId: persisted.tmuxPaneId,
  };
}

export function toPersistedPanel(
  panel: TerminalPanelRecord,
): PersistedTerminalPanelRecord {
  return {
    id: panel.id,
    terminalSessionId: panel.terminalSessionId,
    alias: panel.alias,
    role: panel.role,
    threadId: panel.threadId,
    preview: panel.preview,
    lastThreadId: panel.lastThreadId,
    lastThreadStatus: panel.lastThreadStatus,
    ...(panel.lastThreadUpdatedAt
      ? { lastThreadUpdatedAt: panel.lastThreadUpdatedAt.toISOString() }
      : {}),
    agentTeamRunId: panel.agentTeamRunId,
    agentTeamWorkerId: panel.agentTeamWorkerId,
    cwd: panel.cwd,
    activeCommand: panel.activeCommand,
    ...(panel.terminalState !== undefined
      ? { terminalState: panel.terminalState }
      : {}),
    status: panel.status,
    createdAt: panel.createdAt.toISOString(),
    lastActivityAt: panel.lastActivityAt.toISOString(),
    exitCode: panel.exitCode,
    runtimeKind: panel.runtimeKind,
    tmuxPaneId: panel.tmuxPaneId,
  };
}

export function buildPanelWorkspaceRecord(
  persisted: PersistedTerminalPanelWorkspaceRecord,
): TerminalPanelWorkspaceRecord {
  return {
    terminalSessionId: persisted.terminalSessionId,
    activePanelId: persisted.activePanelId,
    panelIds: [...persisted.panelIds],
    renderMode: persisted.renderMode,
  };
}

export function toPersistedPanelWorkspace(
  workspace: TerminalPanelWorkspaceRecord,
): PersistedTerminalPanelWorkspaceRecord {
  return {
    terminalSessionId: workspace.terminalSessionId,
    activePanelId: workspace.activePanelId,
    panelIds: [...workspace.panelIds],
    renderMode: workspace.renderMode,
  };
}
