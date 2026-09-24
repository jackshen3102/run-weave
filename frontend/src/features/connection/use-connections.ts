import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PackagedBackendConnectionState } from "@runweave/shared/runtime-monitor";
import type { ConnectionRuntime } from "@runweave/shared/remote";
import type { ConnectionConfig, ConnectionStore } from "./types";
import { useProjectBindings } from "./project-bindings";
import {
  buildLocalDevelopmentConnection,
  LOCAL_DEV_CONNECTION_ID,
  shouldExposeLocalDevelopmentConnection,
} from "./system-connection";

const DEFAULT_STORE: ConnectionStore = { connections: [], activeId: null };

const isElectron = window.electronAPI?.isElectron === true;
const managesPackagedBackend =
  window.electronAPI?.managesPackagedBackend === true;
const electronBackendUrl =
  window.electronAPI?.backendUrl?.trim().replace(/\/+$/, "") ?? "";

function getInitialPackagedBackendState(): PackagedBackendConnectionState | null {
  if (
    !shouldExposeLocalDevelopmentConnection(isElectron, managesPackagedBackend)
  ) {
    return null;
  }

  return {
    kind: "packaged-local",
    available: Boolean(electronBackendUrl),
    backendUrl: electronBackendUrl,
    statusMessage: electronBackendUrl ? null : "内置本地后端不可用",
    canReconnect: managesPackagedBackend,
    runtimeSource: null,
    runtimeReleaseId: null,
  };
}

function normalizeDesktopBackendState(
  state: PackagedBackendConnectionState,
): PackagedBackendConnectionState {
  if (managesPackagedBackend) return state;
  const backendUrl = state.backendUrl || electronBackendUrl;
  return {
    ...state,
    available: Boolean(backendUrl),
    backendUrl,
    statusMessage: backendUrl ? null : state.statusMessage,
    canReconnect: false,
  };
}

function loadStore(storageKey: string): ConnectionStore {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return DEFAULT_STORE;

  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionStore>;
    if (!Array.isArray(parsed.connections)) return DEFAULT_STORE;
    return {
      connections: parsed.connections,
      activeId: parsed.activeId ?? null,
    };
  } catch {
    return DEFAULT_STORE;
  }
}

function saveStore(storageKey: string, store: ConnectionStore): void {
  localStorage.setItem(storageKey, JSON.stringify(store));
}

type StoreUpdater = (prev: ConnectionStore) => ConnectionStore;

export interface UseConnectionsResult {
  connections: ConnectionConfig[];
  activeConnection: ConnectionConfig | null;
  addConnection: (name: string, url: string) => ConnectionConfig;
  addRemoteConnection: (name: string, host: string, backendPort: number, browserProfileId: "profile-1" | "profile-2" | "profile-3" | null, approvedBrowserGroupId: string | null) => ConnectionConfig;
  removeConnection: (id: string) => void;
  updateConnection: (
    id: string,
    patch: { name?: string; url?: string },
  ) => void;
  setActive: (id: string) => void;
  clearActive: () => void;
  reconnectSystemConnection: (id: string) => Promise<boolean>;
}

const NOOP_CONN: ConnectionConfig = { id: "", name: "", url: "", createdAt: 0 };
const NOOP_RESULT: UseConnectionsResult = {
  connections: [],
  activeConnection: null,
  addConnection: () => NOOP_CONN,
  addRemoteConnection: () => NOOP_CONN,
  removeConnection: () => {},
  updateConnection: () => {},
  setActive: () => {},
  clearActive: () => {},
  reconnectSystemConnection: async () => false,
};

export function useConnections(storageKey: string): UseConnectionsResult {
  const [store, setStoreState] = useState<ConnectionStore>(() =>
    isElectron ? loadStore(storageKey) : DEFAULT_STORE,
  );
  const [packagedBackendState, setPackagedBackendState] =
    useState<PackagedBackendConnectionState | null>(() =>
      getInitialPackagedBackendState(),
    );
  const [remoteRuntimes, setRemoteRuntimes] = useState<Record<string, ConnectionRuntime>>({});
  const managedRemoteIds = useRef(new Set<string>());

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.connectRemote) return;
    const api = window.electronAPI;
    const unsubscribe = api.onRemoteConnectionStateChange?.((runtime) => {
      setRemoteRuntimes((previous) => ({ ...previous, [runtime.connectionId]: runtime }));
    });
    void api.listRemoteConnections?.().then((runtimes) => {
      setRemoteRuntimes((previous) => ({
        ...Object.fromEntries(runtimes.map((runtime) => [runtime.connectionId, runtime])),
        ...previous,
      }));
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.connectRemote) return;
    const remoteConnections = store.connections.filter((connection) => connection.kind === "ssh");
    const nextIds = new Set(remoteConnections.map((connection) => connection.id));
    for (const id of managedRemoteIds.current) {
      if (!nextIds.has(id)) void window.electronAPI.disconnectRemote?.(id);
    }
    managedRemoteIds.current = nextIds;
    for (const connection of remoteConnections) {
      if (!connection.sshHost || !connection.sshBackendPort) continue;
      void window.electronAPI.connectRemote({
        connectionId: connection.id,
        host: connection.sshHost,
        backendPort: connection.sshBackendPort,
        browserProfileId: connection.browserProfileId ?? null,
        approvedBrowserGroupId: connection.approvedBrowserGroupId ?? null,
      }).then((runtime) => {
        setRemoteRuntimes((previous) => ({ ...previous, [runtime.connectionId]: runtime }));
      }).catch((error: unknown) => {
        setRemoteRuntimes((previous) => ({
          ...previous,
          [connection.id]: {
            connectionId: connection.id,
            generation: 0,
            installationId: null,
            serviceInstanceId: null,
            apiBase: null,
            status: "failed",
            lastObservedAt: null,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      });
    }
  }, [store.connections]);
  const localDevelopmentConnection = useMemo(
    () => buildLocalDevelopmentConnection(packagedBackendState),
    [packagedBackendState],
  );

  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    if (
      !shouldExposeLocalDevelopmentConnection(
        isElectron,
        managesPackagedBackend,
      )
    ) {
      return;
    }

    let disposed = false;
    const electronApi = window.electronAPI;
    const unsubscribe = electronApi?.onPackagedBackendStateChange?.((state) => {
      setPackagedBackendState(normalizeDesktopBackendState(state));
    });

    void electronApi?.getPackagedBackendState?.().then((state) => {
      if (!disposed) {
        setPackagedBackendState(normalizeDesktopBackendState(state));
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    const syncFromStorage = (event: StorageEvent): void => {
      if (event.key !== storageKey) return;
      const next = loadStore(storageKey);
      storeRef.current = next;
      setStoreState(next);
    };
    window.addEventListener("storage", syncFromStorage);
    return () => window.removeEventListener("storage", syncFromStorage);
  }, [storageKey]);

  const persist = useMemoizedFn((updater: StoreUpdater) => {
    const next = updater(storeRef.current);
    storeRef.current = next;
    setStoreState(next);
    saveStore(storageKey, next);
  });

  const connections = useMemo(() => {
    const userConnections = store.connections.filter(
      (connection) => connection.id !== LOCAL_DEV_CONNECTION_ID,
    ).map((connection) => {
      if (connection.kind !== "ssh") return connection;
      const runtime = remoteRuntimes[connection.id];
      return {
        ...connection,
        url: runtime?.apiBase ?? "",
        available: runtime?.status === "ready",
        statusMessage: runtime?.message ?? runtime?.status ?? "连接中",
        canReconnect: runtime?.status === "failed",
        generation: runtime?.generation ?? 0,
        browserAvailable: runtime?.browserAvailable ?? false,
        browserMessage: runtime?.browserMessage ?? null,
        remoteStatus: runtime?.status ?? "connecting",
        installationId: runtime?.installationId ?? null,
        canEdit: false,
      };
    });

    return localDevelopmentConnection
      ? [localDevelopmentConnection, ...userConnections]
      : userConnections;
  }, [localDevelopmentConnection, remoteRuntimes, store.connections]);

  const activeConnection = useMemo(() => {
    if (store.activeId === LOCAL_DEV_CONNECTION_ID) {
      return localDevelopmentConnection;
    }
    return connections.find((connection) => connection.id === store.activeId)
      ?? localDevelopmentConnection;
  }, [connections, localDevelopmentConnection, store.activeId]);

  const addConnection = useMemoizedFn(
    (name: string, url: string): ConnectionConfig => {
      const conn: ConnectionConfig = {
        id: crypto.randomUUID(),
        name: name.trim(),
        url: url.trim().replace(/\/+$/, ""),
        createdAt: Date.now(),
      };
      persist((prev) => ({
        connections: [...prev.connections, conn],
        activeId: conn.id,
      }));
      return conn;
    },
  );

  const addRemoteConnection = useMemoizedFn(
    (name: string, host: string, backendPort: number, browserProfileId: "profile-1" | "profile-2" | "profile-3" | null, approvedBrowserGroupId: string | null): ConnectionConfig => {
      const connection: ConnectionConfig = {
        id: crypto.randomUUID(),
        name: name.trim(),
        url: "",
        createdAt: Date.now(),
        kind: "ssh",
        sshHost: host.trim(),
        sshBackendPort: backendPort,
        browserProfileId,
        approvedBrowserGroupId,
      };
      persist((previous) => ({
        connections: [...previous.connections, connection],
        activeId: connection.id,
      }));
      return connection;
    },
  );

  const removeConnection = useMemoizedFn((id: string) => {
    if (id === LOCAL_DEV_CONNECTION_ID) {
      return;
    }

    persist((prev) => ({
      connections: prev.connections.filter((c) => c.id !== id),
      activeId: prev.activeId === id ? null : prev.activeId,
    }));
    useProjectBindings.getState().removeConnection(id);
  });

  const updateConnection = useMemoizedFn(
    (id: string, patch: { name?: string; url?: string }) => {
      if (id === LOCAL_DEV_CONNECTION_ID) {
        return;
      }

      persist((prev) => ({
        ...prev,
        connections: prev.connections.map((c) => {
          if (c.id !== id) return c;
          return {
            ...c,
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.url !== undefined
              ? { url: patch.url.trim().replace(/\/+$/, "") }
              : {}),
          };
        }),
      }));
    },
  );

  const setActive = useMemoizedFn((id: string) => {
    persist((prev) => ({ ...prev, activeId: id }));
  });

  const clearActive = useMemoizedFn(() => {
    persist((prev) => ({ ...prev, activeId: null }));
  });

  const reconnectSystemConnection = useMemoizedFn(async (id: string) => {
    const remote = storeRef.current.connections.find((connection) => connection.id === id && connection.kind === "ssh");
    if (remote?.sshHost && remote.sshBackendPort && window.electronAPI?.connectRemote) {
      await window.electronAPI.disconnectRemote?.(id);
      const runtime = await window.electronAPI.connectRemote({
        connectionId: id,
        host: remote.sshHost,
        backendPort: remote.sshBackendPort,
        browserProfileId: remote.browserProfileId ?? null,
        approvedBrowserGroupId: remote.approvedBrowserGroupId ?? null,
      });
      setRemoteRuntimes((previous) => ({ ...previous, [id]: runtime }));
      return runtime.status === "ready";
    }
    if (
      !shouldExposeLocalDevelopmentConnection(
        isElectron,
        managesPackagedBackend,
      ) ||
      id !== LOCAL_DEV_CONNECTION_ID
    ) {
      return false;
    }

    const nextState = await window.electronAPI?.restartPackagedBackend?.();
    if (!nextState) {
      return false;
    }

    const normalized = normalizeDesktopBackendState(nextState);
    setPackagedBackendState(normalized);
    return normalized.available;
  });

  return isElectron
    ? {
        connections,
        activeConnection,
        addConnection,
        addRemoteConnection,
        removeConnection,
        updateConnection,
        setActive,
        clearActive,
        reconnectSystemConnection,
      }
    : NOOP_RESULT;
}
