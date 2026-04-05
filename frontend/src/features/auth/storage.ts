export interface ConnectionAuthRecord {
  token?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  refreshToken?: string;
  sessionId?: string;
}

type ConnectionAuthStore = Record<string, ConnectionAuthRecord>;

export const REMEMBERED_CREDENTIALS_STORAGE_KEY =
  "viewer.auth.remembered-credentials";
export const CONNECTION_AUTH_STORAGE_KEY = "viewer.auth.connection-auth";

function loadConnectionAuthStore(): ConnectionAuthStore {
  const raw = localStorage.getItem(CONNECTION_AUTH_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as ConnectionAuthStore;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveConnectionAuthStore(store: ConnectionAuthStore): void {
  localStorage.setItem(CONNECTION_AUTH_STORAGE_KEY, JSON.stringify(store));
}

export function cleanupLegacyAuthStorage(): void {
  localStorage.removeItem(REMEMBERED_CREDENTIALS_STORAGE_KEY);

  const store = loadConnectionAuthStore();
  const sanitizedEntries = Object.entries(store).flatMap(([connectionId, record]) =>
    record.accessToken ||
    record.token ||
    record.refreshToken ||
    record.sessionId ||
    record.accessExpiresAt
      ? [[
          connectionId,
          {
            accessToken: record.accessToken ?? record.token,
            accessExpiresAt:
              record.accessExpiresAt ??
              (record.accessToken ?? record.token ? Date.now() + 15 * 60 * 1000 : undefined),
            refreshToken: record.refreshToken,
            sessionId: record.sessionId ?? "legacy-session",
          } satisfies ConnectionAuthRecord,
        ]]
      : [],
  );
  saveConnectionAuthStore(Object.fromEntries(sanitizedEntries));
}

export function getConnectionAuth(
  connectionId: string | null | undefined,
): ConnectionAuthRecord | null {
  if (!connectionId) {
    return null;
  }

  return loadConnectionAuthStore()[connectionId] ?? null;
}

export function setConnectionAuth(
  connectionId: string,
  auth: ConnectionAuthRecord,
): void {
  const store = loadConnectionAuthStore();
  store[connectionId] = {
    ...auth,
  };
  saveConnectionAuthStore(store);
}

export function clearConnectionAuth(connectionId: string): void {
  const store = loadConnectionAuthStore();
  if (!(connectionId in store)) {
    return;
  }

  delete store[connectionId];
  saveConnectionAuthStore(store);
}

export function setConnectionToken(connectionId: string, token: string): void {
  setConnectionAuth(connectionId, {
    accessToken: token,
    accessExpiresAt: Date.now() + 15 * 60 * 1000,
    sessionId: "legacy-session",
  });
}

export function clearConnectionToken(connectionId: string): void {
  clearConnectionAuth(connectionId);
}
