import type { TerminalState } from "@runweave/shared";

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
  order?: number;
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

export interface UpdateTerminalSessionRuntimeMetadataParams extends TerminalRuntimeMetadata {
  terminalSessionId: string;
}

export interface UpdateTerminalSessionTerminalStateParams {
  terminalSessionId: string;
  terminalState: TerminalState;
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
  updateSessionRuntimeMetadata(
    params: UpdateTerminalSessionRuntimeMetadataParams,
  ): Promise<void>;
  updateSessionTerminalState(
    params: UpdateTerminalSessionTerminalStateParams,
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
