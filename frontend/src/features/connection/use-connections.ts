import { useCallback, useMemo, useRef, useState } from "react";
import type { ConnectionConfig, ConnectionStore } from "./types";

const DEFAULT_STORE: ConnectionStore = { connections: [], activeId: null };

const isElectron = window.electronAPI?.isElectron === true;

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
  removeConnection: (id: string) => void;
  updateConnection: (id: string, patch: { name?: string; url?: string }) => void;
  setActive: (id: string) => void;
  clearActive: () => void;
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
};

export function useConnections(storageKey: string): UseConnectionsResult {
  const [store, setStoreState] = useState<ConnectionStore>(() =>
    isElectron ? loadStore(storageKey) : DEFAULT_STORE,
  );

  const storeRef = useRef(store);
  storeRef.current = store;

  const persist = useCallback(
    (updater: StoreUpdater) => {
      const next = updater(storeRef.current);
      storeRef.current = next;
      setStoreState(next);
      saveStore(storageKey, next);
    },
    [storageKey],
  );

  const activeConnection = useMemo(() => {
    if (!store.activeId) return null;
    return store.connections.find((c) => c.id === store.activeId) ?? null;
  }, [store]);

  const addConnection = useCallback(
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
    [persist],
  );

  const removeConnection = useCallback(
    (id: string) => {
      persist((prev) => ({
        connections: prev.connections.filter((c) => c.id !== id),
        activeId: prev.activeId === id ? null : prev.activeId,
      }));
    },
    [persist],
  );

  const updateConnection = useCallback(
    (id: string, patch: { name?: string; url?: string }) => {
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
    [persist],
  );

  const setActive = useCallback(
    (id: string) => {
      persist((prev) => ({ ...prev, activeId: id }));
    },
    [persist],
  );

  const clearActive = useCallback(() => {
    persist((prev) => ({ ...prev, activeId: null }));
  }, [persist]);

  return isElectron
    ? {
        connections: store.connections,
        activeConnection,
        addConnection,
        removeConnection,
        updateConnection,
        setActive,
        clearActive,
      }
    : NOOP_RESULT;
}
