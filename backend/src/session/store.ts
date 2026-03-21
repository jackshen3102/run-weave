export interface PersistedSessionRecord {
  id: string;
  targetUrl: string;
  connected: boolean;
  profilePath: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface UpdateSessionConnectionParams {
  sessionId: string;
  connected: boolean;
  lastActivityAt: string;
}

export interface SessionStore {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  listSessions(): Promise<PersistedSessionRecord[]>;
  getSession(sessionId: string): Promise<PersistedSessionRecord | null>;
  insertSession(session: PersistedSessionRecord): Promise<void>;
  updateSessionConnection(params: UpdateSessionConnectionParams): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}
