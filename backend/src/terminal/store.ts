export interface PersistedTerminalProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  isDefault: boolean;
}

export interface PersistedTerminalSessionRecord {
  id: string;
  projectId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export interface UpdateTerminalSessionExitParams {
  terminalSessionId: string;
  status: "exited";
  exitCode?: number;
}

export interface UpdateTerminalSessionScrollbackParams {
  terminalSessionId: string;
  scrollback: string;
}

export interface UpdateTerminalSessionMetadataParams {
  terminalSessionId: string;
  name: string;
  cwd: string;
}

export interface UpdateTerminalSessionLaunchParams {
  terminalSessionId: string;
  name: string;
  command: string;
  args: string[];
}

export interface UpdateTerminalProjectParams {
  projectId: string;
  name: string;
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
  getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null>;
  insertSession(session: PersistedTerminalSessionRecord): Promise<void>;
  updateSessionMetadata(
    params: UpdateTerminalSessionMetadataParams,
  ): Promise<void>;
  updateSessionLaunch(params: UpdateTerminalSessionLaunchParams): Promise<void>;
  updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void>;
  updateSessionExit(params: UpdateTerminalSessionExitParams): Promise<void>;
  deleteSession(terminalSessionId: string): Promise<void>;
}
