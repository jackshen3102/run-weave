import { createContext, useContext, useMemo, type ReactNode } from "react";
import { buildConnectionQueryScope } from "../../query/connection-query-provider";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

interface TerminalRuntimeContextValue {
  activeConnectionId: string | null;
  apiBase: string;
  onAuthExpired?: () => void;
  scope: string;
  token: string;
  remote: { endpointId: string; generation: number; browserProfileId: TerminalBrowserProfileId | null } | null;
}

const TerminalRuntimeContext =
  createContext<TerminalRuntimeContextValue | null>(null);

export function TerminalRuntimeProvider({
  activeConnectionId,
  apiBase,
  children,
  onAuthExpired,
  token,
  remote = null,
  connectionGeneration,
}: {
  activeConnectionId?: string | null;
  apiBase: string;
  children: ReactNode;
  onAuthExpired?: () => void;
  token: string;
  remote?: { endpointId: string; generation: number; browserProfileId: TerminalBrowserProfileId | null } | null;
  connectionGeneration?: number;
}) {
  const scope = buildConnectionQueryScope({
    apiBase,
    connectionId: activeConnectionId ?? null,
    generation: remote?.generation ?? connectionGeneration,
  });
  const value = useMemo<TerminalRuntimeContextValue>(
    () => ({
      activeConnectionId: activeConnectionId ?? null,
      apiBase,
      onAuthExpired,
      scope,
      token,
      remote,
    }),
    [activeConnectionId, apiBase, onAuthExpired, remote, scope, token],
  );
  return (
    <TerminalRuntimeContext.Provider value={value}>
      {children}
    </TerminalRuntimeContext.Provider>
  );
}

export function useTerminalRuntime(): TerminalRuntimeContextValue {
  const runtime = useContext(TerminalRuntimeContext);
  if (!runtime) {
    throw new Error("TerminalRuntimeProvider is missing");
  }
  return runtime;
}
