import type { AppAuthSession } from "../services/auth";
import type { AppAuthCredentialStore } from "./app-auth-credential-store.web";
import {
  APP_AUTH_SESSION_INDEX_KEY,
  LEGACY_APP_AUTH_SESSION_KEY,
} from "./app-auth-credential-store.web";
import { NativeSecureCredentials } from "./native-secure-credentials";

interface AppAuthSessionIndexEntry {
  storageKey: string;
  updatedAt: number;
  expiresAt: number;
  sessionId: string;
}

type AppAuthSessionIndex = Record<string, AppAuthSessionIndexEntry>;

function clearLegacyWebViewSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(LEGACY_APP_AUTH_SESSION_KEY);
}

function storageKeyForConnection(connectionId: string): string {
  return `runweave-app-auth-session:${connectionId}`;
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

async function readSecureJson<T>(key: string, fallback: T): Promise<T> {
  const { value } = await NativeSecureCredentials.get({ key });
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    await NativeSecureCredentials.remove({ key });
    return fallback;
  }
}

async function writeSecureJson(key: string, value: unknown): Promise<void> {
  await NativeSecureCredentials.set({ key, value: JSON.stringify(value) });
}

async function readIndex(): Promise<AppAuthSessionIndex> {
  const index = await readSecureJson<AppAuthSessionIndex>(
    APP_AUTH_SESSION_INDEX_KEY,
    {},
  );
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return {};
  }
  return index;
}

async function writeIndex(index: AppAuthSessionIndex): Promise<void> {
  await writeSecureJson(APP_AUTH_SESSION_INDEX_KEY, index);
}

async function readSessionAtKey(
  storageKey: string,
): Promise<AppAuthSession | null> {
  const session = await readSecureJson<unknown>(storageKey, null);
  if (!isAppAuthSession(session)) {
    await NativeSecureCredentials.remove({ key: storageKey });
    return null;
  }
  return session;
}

export const nativeAppAuthCredentialStore: AppAuthCredentialStore = {
  async loadSession(connectionId) {
    clearLegacyWebViewSession();
    const index = await readIndex();
    const indexedEntry = index[connectionId];
    if (!indexedEntry) {
      return null;
    }

    const session = await readSessionAtKey(indexedEntry.storageKey);
    if (session) {
      return session;
    }

    delete index[connectionId];
    await writeIndex(index);
    return null;
  },

  async saveSession(connectionId: string, session: AppAuthSession) {
    clearLegacyWebViewSession();
    const storageKey = storageKeyForConnection(connectionId);
    await writeSecureJson(storageKey, session);
    const index = await readIndex();
    index[connectionId] = {
      storageKey,
      updatedAt: Date.now(),
      expiresAt: session.expiresAt,
      sessionId: session.sessionId,
    };
    await writeIndex(index);
  },

  async clearSession(connectionId) {
    clearLegacyWebViewSession();
    const index = await readIndex();
    const storageKey =
      index[connectionId]?.storageKey ?? storageKeyForConnection(connectionId);
    await NativeSecureCredentials.remove({ key: storageKey });
    delete index[connectionId];
    await writeIndex(index);
  },

  async clearAllSessions() {
    clearLegacyWebViewSession();
    const index = await readIndex();
    await Promise.all(
      Object.values(index).map((entry) =>
        NativeSecureCredentials.remove({ key: entry.storageKey }),
      ),
    );
    await NativeSecureCredentials.remove({ key: APP_AUTH_SESSION_INDEX_KEY });
  },
};
