export interface PersistedRefreshSessionRecord {
  id: string;
  username: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  replacedBySessionId: string | null;
  clientType: "web" | "electron";
  connectionId: string | null;
}

export interface PersistedAuthRecord {
  username: string;
  password: string;
  jwtSecret: string;
  updatedAt: string;
  refreshSessions: PersistedRefreshSessionRecord[];
}

export interface AuthStore {
  initialize(defaultRecord: PersistedAuthRecord): Promise<PersistedAuthRecord>;
  updatePassword(params: {
    password: string;
    jwtSecret: string;
    updatedAt: string;
  }): Promise<PersistedAuthRecord>;
  createRefreshSession(session: PersistedRefreshSessionRecord): Promise<void>;
  getRefreshSession(
    sessionId: string,
  ): Promise<PersistedRefreshSessionRecord | null>;
  replaceRefreshSession(
    sessionId: string,
    nextSession: PersistedRefreshSessionRecord,
  ): Promise<void>;
  revokeRefreshSession(
    sessionId: string,
    revokedAt: string,
  ): Promise<PersistedRefreshSessionRecord | null>;
  revokeRefreshSessions(sessionIds: string[], revokedAt: string): Promise<void>;
  dispose(): Promise<void>;
}
