import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { TerminalUnreadSnapshot } from "@runweave/shared/terminal-unread";
import { HttpError } from "../../services/http";
import { fetchTerminalUnread } from "../../services/terminal/unread";
import type { ConnectionConfig } from "./types";

interface Observation {
  source: string;
  snapshot: TerminalUnreadSnapshot | null;
  stale: boolean;
}

const useCompletionObservations = create<{
  byId: Record<string, Observation>;
  update: (id: string, observation: Observation) => void;
}>((set) => ({
  byId: {},
  update: (id, observation) => set((state) => ({ byId: { ...state.byId, [id]: observation } })),
}));

function source(connection: ConnectionConfig): string {
  return JSON.stringify([connection.url, connection.generation ?? 0]);
}

/** Uses the connection's existing auth owner; reading never acknowledges completion. */
export function useObserveConnectionCompletions(connection: ConnectionConfig, token: string | null): void {
  const { id, url, available } = connection;
  const key = source(connection);
  useEffect(() => {
    const store = useCompletionObservations.getState;
    const previous = () => {
      const value = store().byId[id];
      return value?.source === key ? value.snapshot : null;
    };
    const publish = (snapshot: TerminalUnreadSnapshot | null, stale: boolean) =>
      store().update(id, { source: key, snapshot, stale });
    if (!token) { publish(null, false); return; }
    if (!url || available === false) { publish(previous(), true); return; }
    let disposed = false;
    let controller: AbortController | null = null;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 8_000);
      try {
        const snapshot = await fetchTerminalUnread(url, token, request.signal);
        if (disposed) return;
        if (typeof snapshot.hostId !== "string" || !snapshot.hostId ||
          !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
          !Number.isSafeInteger(snapshot.count) || snapshot.count < 0) throw new Error("Invalid completion snapshot");
        const old = previous();
        if (old?.hostId === snapshot.hostId && old.revision > snapshot.revision) return;
        publish(snapshot, false);
      } catch (error) {
        if (!disposed) {
          const revoked = error instanceof HttpError && [401, 403].includes(error.status);
          publish(revoked ? null : previous(), true);
        }
      } finally {
        window.clearTimeout(timeout);
        polling = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => { disposed = true; window.clearInterval(timer); controller?.abort(); };
  }, [id, url, available, key, token]);
}

export function useConnectionCompletionCounts(connections: ConnectionConfig[], activeId: string | null) {
  const observations = useCompletionObservations((state) => state.byId);
  return useMemo(() => {
    const current = (connection: ConnectionConfig) => {
      const value = observations[connection.id];
      return value?.source === source(connection) ? value : undefined;
    };
    const hosts = new Map<string, Observation>();
    for (const connection of connections) {
      const value = current(connection);
      if (!value?.snapshot) continue;
      const old = hosts.get(value.snapshot.hostId);
      if (!old || old.snapshot!.revision < value.snapshot.revision ||
        (old.snapshot!.revision === value.snapshot.revision && old.stale && !value.stale)) {
        hosts.set(value.snapshot.hostId, value);
      }
    }
    const byId: Record<string, { count: number; stale: boolean }> = {};
    for (const connection of connections) {
      const value = current(connection);
      if (value?.snapshot) {
        const newest = hosts.get(value.snapshot.hostId)!;
        byId[connection.id] = { count: newest.snapshot!.count, stale: value.stale };
      }
    }
    const active = connections.find((connection) => connection.id === activeId);
    const activeHost = active ? current(active)?.snapshot?.hostId : null;
    // Until the current host is known, an address alias must not masquerade as another computer.
    const otherTotal = activeHost ? [...hosts.entries()].reduce(
      (total, [host, value]) => total + (host === activeHost ? 0 : value.snapshot!.count), 0,
    ) : 0;
    return { byId, otherTotal };
  }, [connections, activeId, observations]);
}
