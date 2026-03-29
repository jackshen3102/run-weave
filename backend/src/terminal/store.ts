export interface PersistedTerminalSessionRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  linkedBrowserSessionId?: string;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
}

export interface UpdateTerminalSessionActivityParams {
  terminalSessionId: string;
  lastActivityAt: string;
}

export interface UpdateTerminalSessionExitParams {
  terminalSessionId: string;
  status: "exited";
  exitCode?: number;
  lastActivityAt: string;
}

export interface TerminalSessionStore {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  listSessions(): Promise<PersistedTerminalSessionRecord[]>;
  getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null>;
  insertSession(session: PersistedTerminalSessionRecord): Promise<void>;
  updateSessionName(terminalSessionId: string, name: string): Promise<void>;
  updateSessionActivity(
    params: UpdateTerminalSessionActivityParams,
  ): Promise<void>;
  updateSessionExit(params: UpdateTerminalSessionExitParams): Promise<void>;
  deleteSession(terminalSessionId: string): Promise<void>;
}
