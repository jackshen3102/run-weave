import { create } from "zustand";

import type {
  AppConnectionConfig,
  AppConnectionStore,
} from "../features/connections/types";
import { resolveDefaultApiBase } from "../config/api-base";
import { getAppAuthCredentialStore } from "./app-auth-credential-store";

const STORAGE_KEY = "runweave-app-connections";
const DEFAULT_CONNECTION_ID = "runweave-default";

type ConnectionPatch = Partial<
  Pick<AppConnectionConfig, "name" | "url" | "available" | "statusMessage">
>;

interface AppConnectionStoreState extends AppConnectionStore {
  activeConnection: AppConnectionConfig | null;
  addConnection: (input: { name: string; url: string }) => AppConnectionConfig;
  updateConnection: (id: string, patch: ConnectionPatch) => void;
  removeConnection: (id: string) => void;
  selectConnection: (id: string) => void;
}

function isHttpOrigin(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.location.protocol === "http:" ||
    window.location.protocol === "https:"
  );
}

function normalizeUserUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("后端地址必须以 http:// 或 https:// 开头");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeStoredUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return normalizeUserUrl(trimmed);
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function resolveDefaultConnection(): AppConnectionConfig | null {
  const defaultApiBase = resolveDefaultApiBase();
  if (!defaultApiBase && !isHttpOrigin()) {
    return null;
  }
  return {
    id: DEFAULT_CONNECTION_ID,
    name: "Default backend",
    url: defaultApiBase,
    createdAt: 0,
    available: undefined,
    statusMessage: defaultApiBase ? "Configured from VITE_RUNWEAVE_API_BASE" : "Using current app origin",
    isDefault: true,
    canEdit: false,
    canDelete: false,
  };
}

function readStoredConnections(): AppConnectionStore {
  if (typeof window === "undefined") {
    return { connections: [], activeId: null };
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<AppConnectionStore> | null;
    if (!parsed || !Array.isArray(parsed.connections)) {
      return { connections: [], activeId: null };
    }
    return {
      connections: parsed.connections
        .filter(
          (connection): connection is AppConnectionConfig =>
            Boolean(connection) &&
            typeof connection.id === "string" &&
            typeof connection.name === "string" &&
            typeof connection.url === "string",
        )
        .map((connection) => ({
          ...connection,
          url: normalizeStoredUrl(connection.url),
          createdAt:
            typeof connection.createdAt === "number"
              ? connection.createdAt
              : Date.now(),
          canEdit: connection.canEdit ?? !connection.isDefault,
          canDelete: connection.canDelete ?? !connection.isDefault,
        })),
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
    };
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return { connections: [], activeId: null };
  }
}

function withDefaultConnection(store: AppConnectionStore): AppConnectionStore {
  const defaultConnection = resolveDefaultConnection();
  const connections = store.connections.filter(
    (connection) => connection.id !== DEFAULT_CONNECTION_ID,
  );
  const nextConnections = defaultConnection
    ? [defaultConnection, ...connections]
    : connections;
  const activeId =
    store.activeId && nextConnections.some((connection) => connection.id === store.activeId)
      ? store.activeId
      : (nextConnections[0]?.id ?? null);
  return { connections: nextConnections, activeId };
}

function resolveActiveConnection(store: AppConnectionStore): AppConnectionConfig | null {
  return store.connections.find((connection) => connection.id === store.activeId) ?? null;
}

function persistStore(store: AppConnectionStore): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function updateStore(
  set: (
    partial:
      | AppConnectionStoreState
      | Partial<AppConnectionStoreState>
      | ((state: AppConnectionStoreState) => Partial<AppConnectionStoreState>),
  ) => void,
  updater: (store: AppConnectionStore) => AppConnectionStore,
): void {
  set((current) => {
    const nextStore = updater({
      connections: current.connections,
      activeId: current.activeId,
    });
    persistStore(nextStore);
    return {
      ...nextStore,
      activeConnection: resolveActiveConnection(nextStore),
    };
  });
}

const initialStore = withDefaultConnection(readStoredConnections());

export const useAppConnectionStore = create<AppConnectionStoreState>((set) => ({
  ...initialStore,
  activeConnection: resolveActiveConnection(initialStore),

  addConnection: ({ name, url }) => {
    const connection: AppConnectionConfig = {
      id: createId(),
      name: name.trim() || "Runweave backend",
      url: normalizeUserUrl(url),
      createdAt: Date.now(),
      available: undefined,
      statusMessage: null,
      canEdit: true,
      canDelete: true,
    };
    updateStore(set, (store) => ({
      connections: [...store.connections, connection],
      activeId: connection.id,
    }));
    return connection;
  },

  updateConnection: (id, patch) => {
    updateStore(set, (store) => ({
      ...store,
      connections: store.connections.map((connection) => {
        if (connection.id !== id) {
          return connection;
        }
        const nextUrl =
          patch.url !== undefined && connection.canEdit !== false
            ? normalizeUserUrl(patch.url)
            : connection.url;
        return {
          ...connection,
          ...patch,
          name:
            patch.name !== undefined && connection.canEdit !== false
              ? patch.name.trim() || connection.name
              : connection.name,
          url: nextUrl,
        };
      }),
    }));
  },

  removeConnection: (id) => {
    updateStore(set, (store) => {
      const target = store.connections.find((connection) => connection.id === id);
      if (!target || target.canDelete === false) {
        return store;
      }
      void getAppAuthCredentialStore().clearSession(id);
      const connections = store.connections.filter((connection) => connection.id !== id);
      const activeId =
        store.activeId === id ? (connections[0]?.id ?? null) : store.activeId;
      return { connections, activeId };
    });
  },

  selectConnection: (id) => {
    updateStore(set, (store) => {
      if (!store.connections.some((connection) => connection.id === id)) {
        return store;
      }
      return { ...store, activeId: id };
    });
  },
}));
