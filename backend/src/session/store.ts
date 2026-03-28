import type { SessionHeaders } from "@browser-viewer/shared";

export type SessionProfileMode = "managed" | "custom";

export interface PersistedSessionRecord {
  id: string;
  name: string;
  proxyEnabled: boolean;
  connected: boolean;
  profilePath: string;
  profileMode: SessionProfileMode;
  headers: SessionHeaders;
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
  updateSessionName(sessionId: string, name: string): Promise<void>;
  updateSessionConnection(params: UpdateSessionConnectionParams): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}
