export interface RememberedCredentials {
  username: string;
  password: string;
}

export interface ConnectionAuthRecord {
  token?: string;
  username?: string;
  password?: string;
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
  const current = store[connectionId];
  if (!current) {
    return;
  }

  const next: ConnectionAuthRecord = {
    ...(current.username !== undefined ? { username: current.username } : {}),
    ...(current.password !== undefined ? { password: current.password } : {}),
  };

  if (Object.keys(next).length === 0) {
    delete store[connectionId];
  } else {
    store[connectionId] = next;
  }

  saveConnectionAuthStore(store);
}

export function saveRememberedCredentialsForConnection(
  connectionId: string,
  credentials: RememberedCredentials,
): void {
  const store = loadConnectionAuthStore();
  const current = store[connectionId] ?? {};
  store[connectionId] = {
    ...current,
    username: credentials.username,
    password: credentials.password,
  };
  saveConnectionAuthStore(store);
}

export function clearRememberedCredentialsForConnection(
  connectionId: string,
): void {
  const store = loadConnectionAuthStore();
  const current = store[connectionId];
  if (!current) {
    return;
  }

  const next: ConnectionAuthRecord = {
    ...(current.token !== undefined ? { token: current.token } : {}),
  };

  if (Object.keys(next).length === 0) {
    delete store[connectionId];
  } else {
    store[connectionId] = next;
  }

  saveConnectionAuthStore(store);
}

export function loadRememberedCredentials(params: {
  isElectron?: boolean;
  connectionId?: string;
}): RememberedCredentials | null {
  if (params.isElectron && params.connectionId) {
    const scoped = getConnectionAuth(params.connectionId);
    if (
      typeof scoped?.username === "string" &&
      typeof scoped.password === "string"
    ) {
      return {
        username: scoped.username,
        password: scoped.password,
      };
    }
    return null;
  }

  const storedValue = localStorage.getItem(REMEMBERED_CREDENTIALS_STORAGE_KEY);
  if (!storedValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(storedValue) as Partial<RememberedCredentials>;
    if (
      typeof parsed.username !== "string" ||
      typeof parsed.password !== "string"
    ) {
      return null;
    }

    return {
      username: parsed.username,
      password: parsed.password,
    };
  } catch {
    return null;
  }
}

export function saveRememberedCredentials(
  credentials: RememberedCredentials,
  params: { isElectron?: boolean; connectionId?: string },
): void {
  if (params.isElectron && params.connectionId) {
    saveRememberedCredentialsForConnection(params.connectionId, credentials);
    return;
  }

  localStorage.setItem(
    REMEMBERED_CREDENTIALS_STORAGE_KEY,
    JSON.stringify(credentials),
  );
}

export function clearRememberedCredentials(params: {
  isElectron?: boolean;
  connectionId?: string;
}): void {
  if (params.isElectron && params.connectionId) {
    clearRememberedCredentialsForConnection(params.connectionId);
    return;
  }

  localStorage.removeItem(REMEMBERED_CREDENTIALS_STORAGE_KEY);
}
