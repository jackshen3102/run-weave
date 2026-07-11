import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppConnectionStore } from "../../store/use-app-connection-store";
import { buildAppConnectionQueryScope } from "../query/app-query-provider";

interface AppTerminalRuntime {
  accessToken: string;
  apiBase: string;
  projectId: string | null;
  scope: string;
  terminalSessionId: string;
  onAuthExpired: () => void;
}

const AppTerminalRuntimeContext = createContext<AppTerminalRuntime | null>(
  null,
);

export function AppTerminalRuntimeProvider({
  accessToken,
  apiBase,
  children,
  projectId,
  terminalSessionId,
  onAuthExpired,
}: Omit<AppTerminalRuntime, "scope"> & { children: ReactNode }) {
  const connectionId = useAppConnectionStore(
    (state) => state.activeConnection?.id ?? null,
  );
  const scope = buildAppConnectionQueryScope({ connectionId, apiBase });
  const value = useMemo<AppTerminalRuntime>(
    () => ({
      accessToken,
      apiBase,
      projectId,
      scope,
      terminalSessionId,
      onAuthExpired,
    }),
    [accessToken, apiBase, onAuthExpired, projectId, scope, terminalSessionId],
  );
  return (
    <AppTerminalRuntimeContext.Provider value={value}>
      {children}
    </AppTerminalRuntimeContext.Provider>
  );
}

export function useAppTerminalRuntime(): AppTerminalRuntime {
  const runtime = useContext(AppTerminalRuntimeContext);
  if (!runtime) {
    throw new Error("AppTerminalRuntimeProvider is missing");
  }
  return runtime;
}
