export interface ConnectionAuthRecord {
  token?: string;
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
    record.token ? [[connectionId, { token: record.token } satisfies ConnectionAuthRecord]] : [],
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

export function setConnectionToken(
  connectionId: string,
  token: string,
): void {
  const store = loadConnectionAuthStore();
  const current = store[connectionId] ?? {};
  store[connectionId] = {
    ...current,
    token,
  };
  saveConnectionAuthStore(store);
}

export function clearConnectionToken(connectionId: string): void {
  const store = loadConnectionAuthStore();
  if (!(connectionId in store)) {
    return;
  }

  delete store[connectionId];
  saveConnectionAuthStore(store);
}
