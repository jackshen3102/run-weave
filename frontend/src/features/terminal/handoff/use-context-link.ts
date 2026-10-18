import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useSuijiConnection } from "../../suiji/connection-provider";
import { useTerminalRuntime } from "../queries/provider";
import {
  handoffContextLinks,
  handoffAccountKey,
  type HandoffBackend,
  type HandoffAccount,
  type LocalHandoffLink,
} from "./context-link-store";

export function useHandoffLinks() {
  const runtime = useTerminalRuntime();
  const suiji = useSuijiConnection();
  const backend: HandoffBackend = {
    connectionId: runtime.activeConnectionId,
    apiBase: runtime.apiBase.trim().replace(/\/+$/, "") || "same-origin",
    endpointId: runtime.remote?.endpointId ?? null,
  };
  const connection = suiji.connection;
  const account: HandoffAccount | null =
    connection && connection.client.active && suiji.accounts
      ? {
          environment: suiji.accounts.active,
          endpoint: connection.client.endpoint,
          serverId: connection.info.serverId,
          ownerId: connection.info.ownerId,
        }
      : null;
  const scope = account ? handoffAccountKey(backend, account) : "";
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    links: LocalHandoffLink[];
    error: string;
  }>({ scope: "", links: [], error: "" });
  const sequence = useRef(0);
  const reload = useMemoizedFn(async () => {
    const ticket = ++sequence.current;
    if (!account || !scope) return;
    try {
      const links = await handoffContextLinks.list(backend, account);
      if (
        ticket === sequence.current &&
        currentScope.current === scope &&
        connection?.client.active
      )
        setSnapshot({ scope, links, error: "" });
    } catch (error) {
      if (ticket === sequence.current && currentScope.current === scope)
        setSnapshot({
          scope,
          links: [],
          error: error instanceof Error ? error.message : "读取关联失败",
        });
    }
  });
  useEffect(() => {
    const counter = sequence;
    void reload();
    const unsubscribe = handoffContextLinks.subscribe(() => {
      void reload();
    });
    return () => {
      ++counter.current;
      unsubscribe();
    };
  }, [scope, reload]);
  return {
    backend,
    account,
    scope,
    links: snapshot.scope === scope ? snapshot.links : [],
    error: snapshot.scope === scope ? snapshot.error : "",
    reload,
    isCurrent: () =>
      currentScope.current === scope &&
      !!connection &&
      suiji.isCurrent(connection.client),
  };
}
