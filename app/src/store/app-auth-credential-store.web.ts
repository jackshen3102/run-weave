import type { AppAuthSession } from "../services/auth";

export const LEGACY_APP_AUTH_SESSION_KEY = "runweave-app-auth-session";
export const APP_AUTH_SESSION_INDEX_KEY = "runweave-app-auth-session-index";

interface AppAuthSessionIndexEntry {
  storageKey: string;
  updatedAt: number;
  expiresAt: number;
  sessionId: string;
  migratedFromLegacy?: boolean;
}

type AppAuthSessionIndex = Record<string, AppAuthSessionIndexEntry>;

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    window.localStorage.removeItem(key);
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
}

function isAppAuthSession(value: unknown): value is AppAuthSession {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as AppAuthSession).accessToken === "string" &&
    typeof (value as AppAuthSession).refreshToken === "string" &&
    typeof (value as AppAuthSession).sessionId === "string" &&
    typeof (value as AppAuthSession).expiresAt === "number" &&
    typeof (value as AppAuthSession).expiresIn === "number"
  );
}

function readIndex(): AppAuthSessionIndex {
  const index = readJson<AppAuthSessionIndex>(APP_AUTH_SESSION_INDEX_KEY, {});
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return {};
  }
  return index;
}

function writeIndex(index: AppAuthSessionIndex): void {
  writeJson(APP_AUTH_SESSION_INDEX_KEY, index);
}

function storageKeyForConnection(connectionId: string): string {
  return `runweave-app-auth-session:${connectionId}`;
}

function readSessionAtKey(storageKey: string): AppAuthSession | null {
  const session = readJson<unknown>(storageKey, null);
  if (!isAppAuthSession(session)) {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey);
    }
    return null;
  }
  return session;
}

export interface AppAuthCredentialStore {
  loadSession(connectionId: string): Promise<AppAuthSession | null>;
  saveSession(connectionId: string, session: AppAuthSession): Promise<void>;
  clearSession(connectionId: string): Promise<void>;
  clearAllSessions(): Promise<void>;
}

export const webAppAuthCredentialStore: AppAuthCredentialStore = {
  async loadSession(connectionId) {
    const index = readIndex();
    const indexedEntry = index[connectionId];
    if (indexedEntry) {
      const session = readSessionAtKey(indexedEntry.storageKey);
      if (session) {
        return session;
      }
      delete index[connectionId];
      writeIndex(index);
    }

    const legacySession = readSessionAtKey(LEGACY_APP_AUTH_SESSION_KEY);
    if (!legacySession || Object.keys(index).length > 0) {
      return null;
    }

    await this.saveSession(connectionId, legacySession);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LEGACY_APP_AUTH_SESSION_KEY);
    }
    const migratedIndex = readIndex();
    if (migratedIndex[connectionId]) {
      migratedIndex[connectionId] = {
        ...migratedIndex[connectionId],
        migratedFromLegacy: true,
      };
      writeIndex(migratedIndex);
    }
    return legacySession;
  },

  async saveSession(connectionId, session) {
    const storageKey = storageKeyForConnection(connectionId);
    writeJson(storageKey, session);
    const index = readIndex();
    index[connectionId] = {
      storageKey,
      updatedAt: Date.now(),
      expiresAt: session.expiresAt,
      sessionId: session.sessionId,
    };
    writeIndex(index);
  },

  async clearSession(connectionId) {
    const index = readIndex();
    const storageKey = index[connectionId]?.storageKey ?? storageKeyForConnection(connectionId);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey);
    }
    delete index[connectionId];
    writeIndex(index);
  },

  async clearAllSessions() {
    const index = readIndex();
    if (typeof window !== "undefined") {
      for (const entry of Object.values(index)) {
        window.localStorage.removeItem(entry.storageKey);
      }
      window.localStorage.removeItem(APP_AUTH_SESSION_INDEX_KEY);
      window.localStorage.removeItem(LEGACY_APP_AUTH_SESSION_KEY);
    }
  },
};
