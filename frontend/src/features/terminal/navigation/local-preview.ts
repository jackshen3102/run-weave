import { useEffect, useMemo } from "react";
import type { DesktopLocalBrowserSource } from "@runweave/shared/browser-local-tunnel";
import { LOCAL_DEV_CONNECTION_ID } from "../../connection/system-connection";
import { useTerminalRuntime } from "../queries/provider";

export function useLocalBrowserSource(terminalSessionId: string | null): DesktopLocalBrowserSource | undefined {
  const { activeConnectionId, connectionName, scope, apiBase, token } = useTerminalRuntime();
  const source = useMemo(() => activeConnectionId && activeConnectionId !== LOCAL_DEV_CONNECTION_ID && terminalSessionId ? {
    connectionId: activeConnectionId, connectionName, scope, apiBase, accessToken: token, terminalSessionId,
  } : undefined, [activeConnectionId, connectionName, scope, apiBase, token, terminalSessionId]);
  useEffect(() => {
    if (source) void window.electronAPI?.terminalBrowserSyncSource?.(source).catch(() => undefined);
  }, [source]);
  return source;
}
