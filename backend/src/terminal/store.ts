export interface PersistedTerminalSessionRecord {
  id: string;
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

export interface TerminalSessionStore {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  listSessions(): Promise<PersistedTerminalSessionRecord[]>;
  getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null>;
  insertSession(session: PersistedTerminalSessionRecord): Promise<void>;
  updateSessionMetadata(
    params: UpdateTerminalSessionMetadataParams,
  ): Promise<void>;
  updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void>;
  updateSessionExit(params: UpdateTerminalSessionExitParams): Promise<void>;
  deleteSession(terminalSessionId: string): Promise<void>;
}
