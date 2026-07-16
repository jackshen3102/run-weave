import type { TerminalLastThreadStatus } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";

export interface PersistedTerminalProjectRecord {
  id: string;
  name: string;
  path?: string | null;
  createdAt: string;
  isDefault: boolean;
  order?: number;
}

export interface PersistedTerminalSessionRecord {
  id: string;
  projectId: string;
  alias?: string | null;
  threadId?: string;
  threadProvider?: TerminalAgentKind;
  preview?: string;
  lastThreadId?: string;
  lastThreadProvider?: TerminalAgentKind;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: string;
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  scrollback: string;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt?: string;
  exitCode?: number;
  runtimeKind?: TerminalRuntimeKind;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  tmuxUnavailableReason?: string;
  recoverable?: boolean;
  terminalState?: TerminalState;
  completionRevision?: number;
  acknowledgedCompletionRevision?: number;
  panelSplitEnabled?: boolean;
  order?: number;
}

export interface PersistedTerminalPanelRecord {
  id: string;
  terminalSessionId: string;
  alias?: string | null;
  role?: string | null;
  threadId?: string;
  threadProvider?: TerminalAgentKind;
  preview?: string;
  lastThreadId?: string;
  lastThreadProvider?: TerminalAgentKind;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: string;
  agentTeamRunId?: string | null;
  agentTeamWorkerId?: string | null;
  cwd: string;
  activeCommand: string | null;
  terminalState?: TerminalState;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  runtimeKind: "tmux";
  tmuxPaneId: string;
}

export interface PersistedTerminalPanelWorkspaceRecord {
  terminalSessionId: string;
  activePanelId: string;
  panelIds: string[];
  renderMode: "tmux-native";
}

export type PersistedTerminalSessionMetadataRecord = Omit<
  PersistedTerminalSessionRecord,
  "scrollback"
>;

export type TerminalRuntimeKind = "pty" | "tmux";

export interface TerminalRuntimeMetadata {
  runtimeKind: TerminalRuntimeKind;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  tmuxUnavailableReason?: string;
  recoverable?: boolean;
}

export interface UpdateTerminalSessionExitParams {
  terminalSessionId: string;
  status: "exited";
  lastActivityAt?: string;
  exitCode?: number;
}

export interface UpdateTerminalSessionStatusParams {
  terminalSessionId: string;
  status: "running" | "exited";
  lastActivityAt?: string;
  exitCode?: number;
}

export interface UpdateTerminalSessionScrollbackParams {
  terminalSessionId: string;
  scrollback: string;
}

export interface AppendTerminalSessionScrollbackParams {
  terminalSessionId: string;
  chunk: string;
}

export interface UpdateTerminalSessionMetadataParams {
  terminalSessionId: string;
  cwd: string;
  activeCommand: string | null;
  lastActivityAt?: string;
}

export interface UpdateTerminalSessionActivityParams {
  terminalSessionId: string;
  lastActivityAt: string;
}

export interface UpdateTerminalSessionLaunchParams {
  terminalSessionId: string;
  command: string;
  args: string[];
}

export interface UpdateTerminalSessionAliasParams {
  terminalSessionId: string;
  alias: string | null;
}

export interface UpdateTerminalSessionThreadIdParams {
  terminalSessionId: string;
  threadId: string | null;
  provider: TerminalAgentKind | null;
}

export interface UpdateTerminalSessionPreviewParams {
  terminalSessionId: string;
  preview: string | null;
}

export interface UpdateTerminalSessionLastThreadParams {
  terminalSessionId: string;
  threadId: string;
  provider: TerminalAgentKind;
  status: TerminalLastThreadStatus;
  updatedAt: string;
}

export interface UpdateTerminalSessionRuntimeMetadataParams extends TerminalRuntimeMetadata {
  terminalSessionId: string;
}

export interface UpdateTerminalSessionTerminalStateParams {
  terminalSessionId: string;
  terminalState: TerminalState;
}

export interface UpdateTerminalSessionCompletionParams {
  terminalSessionId: string;
  completionRevision: number;
  acknowledgedCompletionRevision: number;
}

export interface UpdateTerminalPanelThreadIdParams {
  panelId: string;
  threadId: string | null;
  provider: TerminalAgentKind | null;
}

export interface UpdateTerminalPanelPreviewParams {
  panelId: string;
  preview: string | null;
}

export interface UpdateTerminalPanelLastThreadParams {
  panelId: string;
  threadId: string;
  provider: TerminalAgentKind;
  status: TerminalLastThreadStatus;
  updatedAt: string;
}

export interface UpdateTerminalPanelTerminalStateParams {
  panelId: string;
  terminalState: TerminalState;
}

export interface UpdateTerminalSessionPanelSplitEnabledParams {
  terminalSessionId: string;
  panelSplitEnabled: boolean;
}

export interface UpsertTerminalPanelParams {
  panel: PersistedTerminalPanelRecord;
}

export interface UpdateTerminalPanelWorkspaceParams {
  workspace: PersistedTerminalPanelWorkspaceRecord;
}

export interface UpdateTerminalPanelStatusParams {
  panelId: string;
  status: "running" | "exited";
  lastActivityAt?: string;
  exitCode?: number;
}

export interface UpdateTerminalProjectParams {
  projectId: string;
  name?: string;
  path?: string | null;
}

export interface TerminalSessionStore {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  listProjects(): Promise<PersistedTerminalProjectRecord[]>;
  getProject(projectId: string): Promise<PersistedTerminalProjectRecord | null>;
  insertProject(project: PersistedTerminalProjectRecord): Promise<void>;
  updateProject(params: UpdateTerminalProjectParams): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  setDefaultProject(projectId: string): Promise<void>;
  listSessions(): Promise<PersistedTerminalSessionRecord[]>;
  listSessionMetadata(): Promise<PersistedTerminalSessionMetadataRecord[]>;
  getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null>;
  listPanels(): Promise<PersistedTerminalPanelRecord[]>;
  listPanelWorkspaces(): Promise<PersistedTerminalPanelWorkspaceRecord[]>;
  upsertPanel(params: UpsertTerminalPanelParams): Promise<void>;
  updatePanelThreadId(params: UpdateTerminalPanelThreadIdParams): Promise<void>;
  updatePanelPreview(params: UpdateTerminalPanelPreviewParams): Promise<void>;
  updatePanelLastThread(
    params: UpdateTerminalPanelLastThreadParams,
  ): Promise<void>;
  updatePanelTerminalState(
    params: UpdateTerminalPanelTerminalStateParams,
  ): Promise<void>;
  updatePanelStatus(params: UpdateTerminalPanelStatusParams): Promise<void>;
  updatePanelWorkspace(
    params: UpdateTerminalPanelWorkspaceParams,
  ): Promise<void>;
  deletePanelsForSession(terminalSessionId: string): Promise<void>;
  readSessionScrollback(terminalSessionId: string): Promise<string>;
  readSessionLiveScrollback(terminalSessionId: string): Promise<string>;
  insertSession(session: PersistedTerminalSessionRecord): Promise<void>;
  updateSessionMetadata(
    params: UpdateTerminalSessionMetadataParams,
  ): Promise<void>;
  updateSessionActivity(
    params: UpdateTerminalSessionActivityParams,
  ): Promise<void>;
  updateSessionLaunch(params: UpdateTerminalSessionLaunchParams): Promise<void>;
  updateSessionAlias(params: UpdateTerminalSessionAliasParams): Promise<void>;
  updateSessionThreadId(
    params: UpdateTerminalSessionThreadIdParams,
  ): Promise<void>;
  updateSessionPreview(
    params: UpdateTerminalSessionPreviewParams,
  ): Promise<void>;
  updateSessionLastThread(
    params: UpdateTerminalSessionLastThreadParams,
  ): Promise<void>;
  updateSessionRuntimeMetadata(
    params: UpdateTerminalSessionRuntimeMetadataParams,
  ): Promise<void>;
  updateSessionTerminalState(
    params: UpdateTerminalSessionTerminalStateParams,
  ): Promise<void>;
  updateSessionCompletion(
    params: UpdateTerminalSessionCompletionParams,
  ): Promise<void>;
  updateSessionPanelSplitEnabled(
    params: UpdateTerminalSessionPanelSplitEnabledParams,
  ): Promise<void>;
  updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void>;
  appendSessionScrollback(
    params: AppendTerminalSessionScrollbackParams,
  ): Promise<void>;
  updateSessionStatus(params: UpdateTerminalSessionStatusParams): Promise<void>;
  updateSessionExit(params: UpdateTerminalSessionExitParams): Promise<void>;
  reorderProjects(orderedIds: string[]): Promise<void>;
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>;
  deleteSession(terminalSessionId: string): Promise<void>;
}
