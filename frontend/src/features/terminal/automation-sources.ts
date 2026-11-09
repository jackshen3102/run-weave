import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { AgentObserverTerminalSource } from "@runweave/shared/terminal-browser-automation";
import { useConnections } from "../connection/use-connections";
import type { ConnectionConfig } from "../connection/types";
import { getConnectionAuth } from "../auth/storage";
import { listTerminalProjects, listTerminalSessions } from "../../services/terminal/index";

export function useObserverSources() {
  const { connections } = useConnections("viewer.connections");
  const [sources, setSources] = useState<AgentObserverTerminalSource[]>([]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const results = await Promise.allSettled(connections.filter(c => c.available !== false).map(async connection => {
        const auth = getConnectionAuth(connection.id);
        const token = auth?.accessToken ?? auth?.token;
        if (!token) return [];
        const [sessions, projects] = await Promise.all([
          listTerminalSessions(connection.url, token), listTerminalProjects(connection.url, token),
        ]);
        return sessions.map(session => ({ connectionId: connection.id, terminalSessionId: session.terminalSessionId,
          label: session.alias?.trim() || `Terminal ${session.terminalSessionId.slice(0, 8)}`,
          project: `${connection.name} · ${projects.find(p => p.projectId === session.projectId)?.name ?? session.projectId}`,
        }));
      }));
      if (!disposed) {
        setSources(results.flatMap(result => result.status === "fulfilled" ? result.value : []));
        timer = setTimeout(() => void poll(), 10000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [connections]);
  return sources;
}

export function useObserverTerminalNavigation(connections: ConnectionConfig[], select: (id: string) => void, navigate: (path: string) => void, prepare: (action: () => void) => void) {
  const [error, setError] = useState<string | null>(null);
  const open = useMemoizedFn(async (source: { connectionId: string; terminalSessionId: string }) => {
    try {
      const connection = connections.find(c => c.id === source.connectionId && c.available !== false);
      const auth = getConnectionAuth(source.connectionId);
      const token = auth?.accessToken ?? auth?.token;
      if (!connection || !token) throw new Error("来源电脑不可用或需要登录");
      const sessions = await listTerminalSessions(connection.url, token);
      if (!sessions.some(s => s.terminalSessionId === source.terminalSessionId)) throw new Error("来源终端已不存在");
      setError(null);
      prepare(() => {
        select(connection.id);
        navigate(`/terminal/${encodeURIComponent(source.terminalSessionId)}`);
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法返回来源终端"); }
  });
  useEffect(() => window.electronAPI?.onAgentObserverTerminal?.(source => { void open(source); }), [open]);
  return { error, dismiss: () => setError(null) };
}
