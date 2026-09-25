import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { AttentionSnapshot } from "@runweave/shared/attention";
import { useScopedAuth } from "../auth/use-scoped-auth";
import { useTerminalEventsConnection } from "../terminal/connection/use-events";
import { listTerminalProjects, listTerminalSessions } from "../../services/terminal/index";
import { useAttentionSnapshot } from "../attention/use-attention-snapshot";
import type { ConnectionConfig } from "./types";

export interface ConnectionWorkspaceOverview {
  projects: TerminalProjectListItem[];
  sessions: TerminalSessionListItem[];
  attention: AttentionSnapshot | null;
  observedAt: string | null;
  status: "ready" | "disconnected" | "needs_auth" | "checking";
}

interface OverviewStore {
  byConnectionId: Record<string, ConnectionWorkspaceOverview>;
  update: (connectionId: string, patch: Partial<ConnectionWorkspaceOverview>) => void;
}

export const useConnectionWorkspaceOverview = create<OverviewStore>((set) => ({
  byConnectionId: {},
  update: (connectionId, patch) => set((state) => ({
    byConnectionId: {
      ...state.byConnectionId,
      [connectionId]: {
        projects: [],
        sessions: [],
        attention: null,
        observedAt: null,
        status: "checking",
        ...state.byConnectionId[connectionId],
        ...patch,
      },
    },
  })),
}));

const observedAttentionIds = new Map<string, Set<string>>();

function publishNewAttention(connection: ConnectionConfig, snapshot: AttentionSnapshot): void {
  const previous = observedAttentionIds.get(connection.id);
  const current = new Set(snapshot.slots.map((slot) => slot.attentionId));
  const seen = new Set([...(previous ?? []), ...current]);
  while (seen.size > 500) seen.delete(seen.values().next().value!);
  observedAttentionIds.set(connection.id, seen);
  if (!previous) return;
  for (const slot of snapshot.slots) {
    if (previous.has(slot.attentionId) || slot.state === "working") continue;
    void window.electronAPI?.showAttentionNotification?.({
      connectionId: connection.id,
      attentionId: slot.attentionId,
      parentProjectId: slot.parentProjectId,
      projectId: slot.projectId,
      terminalSessionId: slot.terminalSessionId,
      panelId: slot.panelId,
      title: `${connection.name} · ${slot.projectName}`,
      body: slot.title,
    }).catch(() => undefined);
  }
}

function AuthenticatedObserver({
  connection,
  token,
  onAuthExpired,
}: {
  connection: ConnectionConfig;
  token: string;
  onAuthExpired: () => void;
}) {
  const update = useConnectionWorkspaceOverview((state) => state.update);
  const attention = useAttentionSnapshot({ apiBase: connection.url, token, connectionId: connection.id });
  const [revision, setRevision] = useState(0);
  const cursor = useRef<string | null>(null);
  const stream = useTerminalEventsConnection({
    apiBase: connection.url,
    token,
    getCursor: () => cursor.current,
    setCursor: (value) => { cursor.current = value; },
    onAuthExpired,
    onResyncRequired: () => setRevision((current) => current + 1),
    onTerminalEvents: () => setRevision((current) => current + 1),
  });

  useEffect(() => {
    if (attention.state === "ready" && attention.snapshot) {
      update(connection.id, { attention: attention.snapshot });
      publishNewAttention(connection, attention.snapshot);
    }
  }, [attention.snapshot, attention.state, connection, update]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listTerminalProjects(connection.url, token),
      listTerminalSessions(connection.url, token),
    ]).then(([projects, sessions]) => {
      if (cancelled) return;
      update(connection.id, { projects, sessions, observedAt: new Date().toISOString(), status: "ready" });
    }).catch(() => {
      if (!cancelled) update(connection.id, { status: "disconnected" });
    });
    return () => { cancelled = true; };
  }, [connection.id, connection.url, revision, token, update]);

  useEffect(() => {
    if (stream.connectionStatus !== "connected") {
      update(connection.id, { status: "disconnected" });
    } else {
      setRevision((current) => current + 1);
    }
  }, [connection.id, stream.connectionStatus, update]);
  return null;
}

type ScopedAuthState = ReturnType<typeof useScopedAuth>;

function ConnectionObserverState({ connection, token, status, onAuthExpired }: {
  connection: ConnectionConfig;
  token: string | null;
  status: ScopedAuthState["status"];
  onAuthExpired: () => void;
}) {
  const update = useConnectionWorkspaceOverview((state) => state.update);
  useEffect(() => {
    if (!connection.url || connection.available === false) {
      update(connection.id, { status: "disconnected" });
    } else if (status === "checking") {
      update(connection.id, { status: "checking" });
    } else if (status === "unauthenticated" || !token) {
      update(connection.id, { status: "needs_auth" });
    }
  }, [connection.available, connection.id, connection.url, status, token, update]);
  // Never send an expired access token while its refresh is still in flight.
  if (!connection.url || status !== "authenticated" || !token || connection.available === false) return null;
  return <AuthenticatedObserver key={`${connection.id}:${connection.generation ?? 0}`} connection={connection} token={token} onAuthExpired={onAuthExpired} />;
}

function ConnectionObserver({ connection }: { connection: ConnectionConfig }) {
  const { token, status, clearToken } = useScopedAuth({
    apiBase: connection.url,
    connectionId: connection.id,
    isElectron: true,
    webStorageKey: "viewer.auth.token",
  });
  return <ConnectionObserverState connection={connection} token={token} status={status} onAuthExpired={clearToken} />;
}

function ActiveAttentionObserver({ connection, token }: { connection: ConnectionConfig; token: string | null }) {
  const update = useConnectionWorkspaceOverview((state) => state.update);
  const attention = useAttentionSnapshot({
    apiBase: connection.url,
    token,
    connectionId: connection.id,
    enabled: connection.available !== false,
  });
  useEffect(() => {
    if (attention.state === "ready" && attention.snapshot) {
      update(connection.id, { attention: attention.snapshot });
      publishNewAttention(connection, attention.snapshot);
    }
  }, [attention.snapshot, attention.state, connection, update]);
  return null;
}

export function ConnectionWorkspaceObservers({
  connections,
  activeConnectionId,
  activeToken,
  activeAuthStatus,
  onActiveAuthExpired,
  observeActive,
}: {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  activeToken: string | null;
  activeAuthStatus: ScopedAuthState["status"];
  onActiveAuthExpired: () => void;
  observeActive: boolean;
}) {
  return <>
    {connections.filter((connection) => connection.id !== activeConnectionId).map((connection) => (
      <ConnectionObserver key={connection.id} connection={connection} />
    ))}
    {observeActive && connections.filter((connection) => connection.id === activeConnectionId).map((connection) => (
      <ConnectionObserverState key={`active:${connection.id}`} connection={connection} token={activeToken} status={activeAuthStatus} onAuthExpired={onActiveAuthExpired} />
    ))}
    {!observeActive && connections.filter((connection) => connection.id === activeConnectionId).map((connection) => (
      <ActiveAttentionObserver key={`attention:${connection.id}`} connection={connection} token={activeToken} />
    ))}
  </>;
}
