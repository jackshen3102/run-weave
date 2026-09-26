import { deviceStorage } from "../device-storage";
import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PackagedBackendConnectionState } from "@runweave/shared/runtime-monitor";
import { useTunnelStore } from "../tunnels/store";
import { migrateLegacyTunnels } from "../tunnels/migration";
import type { ConnectionConfig, ConnectionStore } from "./types";
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
  const raw = deviceStorage.getItem(storageKey);
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
  deviceStorage.setItem(storageKey, JSON.stringify(store));
}

type StoreUpdater = (prev: ConnectionStore) => ConnectionStore;

export interface UseConnectionsResult {
  connections: ConnectionConfig[];
  activeConnection: ConnectionConfig | null;
  addConnection: (name: string, url: string, tunnelEndpointId?: string) => ConnectionConfig;
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
  const snapshot = useTunnelStore((state) => state.snapshot);
  useEffect(() => {
    if (!isElectron) return;
    void migrateLegacyTunnels(storageKey).then(() => {
      const next = loadStore(storageKey);
      storeRef.current = next;
      setStoreState(next);
    }).catch((error: unknown) => useTunnelStore.getState().setError(String(error)));
  }, [storageKey]);
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
      if (!connection.tunnelEndpointId) return connection;
      const endpoint = snapshot?.config.backendEndpoints.find(e => e.id === connection.tunnelEndpointId);
      const host = snapshot?.config.hosts.find(h => h.id === endpoint?.hostId);
      const runtime = snapshot?.hosts.find(h => h.hostId === endpoint?.hostId);
      const url = runtime?.endpoints[connection.tunnelEndpointId] ?? "";
      return {
        ...connection, url, tunnelHostId: endpoint?.hostId,
        available: Boolean(url) && runtime?.state === "ready",
        statusMessage: runtime?.error?.message ?? "等待 SSH 通道，请在端口与隧道中连接主机",
        canReconnect: false,
        generation: runtime?.generation ?? 0,
        browserProfileId: host?.browser.profileId ?? null,
        browserAvailable: runtime?.browser.state === "ready",
        browserMessage: runtime?.browser.error?.message ?? null,
        remoteStatus: runtime?.state ?? "disconnected",
        installationId: runtime?.installationId ?? null,
        canEdit: false,
      };
    });

    return localDevelopmentConnection
      ? [localDevelopmentConnection, ...userConnections]
      : userConnections;
  }, [localDevelopmentConnection, snapshot, store.connections]);

  const activeConnection = useMemo(() => {
    if (store.activeId === LOCAL_DEV_CONNECTION_ID) {
      return localDevelopmentConnection;
    }
    return connections.find((connection) => connection.id === store.activeId)
      ?? localDevelopmentConnection;
  }, [connections, localDevelopmentConnection, store.activeId]);

  const addConnection = useMemoizedFn(
    (name: string, url: string, tunnelEndpointId?: string): ConnectionConfig => {
      const conn: ConnectionConfig = {
        id: crypto.randomUUID(),
        name: name.trim(),
        url: url.trim().replace(/\/+$/, ""),
        createdAt: Date.now(),
        ...(tunnelEndpointId ? {tunnelEndpointId} : {}),
      };
      persist((prev) => ({
        connections: [...prev.connections, conn],
        activeId: conn.id,
      }));
      return conn;
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
        removeConnection,
        updateConnection,
        setActive,
        clearActive,
        reconnectSystemConnection,
      }
    : NOOP_RESULT;
}
