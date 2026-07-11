import { createContext, useContext, useMemo, type ReactNode } from "react";
import { buildConnectionQueryScope } from "../../query/connection-query-provider";

interface TerminalRuntimeContextValue {
  apiBase: string;
  onAuthExpired?: () => void;
  scope: string;
  token: string;
}

const TerminalRuntimeContext =
  createContext<TerminalRuntimeContextValue | null>(null);

export function TerminalRuntimeProvider({
  activeConnectionId,
  apiBase,
  children,
  onAuthExpired,
  token,
}: {
  activeConnectionId?: string | null;
  apiBase: string;
  children: ReactNode;
  onAuthExpired?: () => void;
  token: string;
}) {
  const scope = buildConnectionQueryScope({
    apiBase,
    connectionId: activeConnectionId ?? null,
  });
  const value = useMemo<TerminalRuntimeContextValue>(
    () => ({ apiBase, onAuthExpired, scope, token }),
    [apiBase, onAuthExpired, scope, token],
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
