import { createContext, useContext, type ReactNode } from "react";
import type { ConnectionConfig } from "../connection/types";
import { useScopedAuth } from "../auth/use-scoped-auth";
export type SettingsAuth = Pick<
  ReturnType<typeof useScopedAuth>,
  "token" | "sessionId" | "status" | "setSession" | "clearToken"
>;
export interface SettingsTarget {
  connection: ConnectionConfig | undefined;
  connectionId: string | null;
  apiBase: string;
  generation: number | undefined;
  auth: SettingsAuth;
}
const Context = createContext<SettingsTarget | null>(null);
export function useSettingsTarget() {
  const target = useContext(Context);
  if (!target) throw new Error("Settings target required");
  return target;
}
function RemoteTarget({
  connection,
  children,
}: {
  connection: ConnectionConfig;
  children: ReactNode;
}) {
  const auth = useScopedAuth({
    apiBase: connection.url,
    connectionId: connection.id,
    isElectron: true,
    webStorageKey: "viewer.auth.token",
  });
  return (
    <Context.Provider
      value={{
        connection,
        connectionId: connection.id,
        apiBase: connection.url,
        generation: connection.generation,
        auth,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function SettingsTargetProvider({
  connection,
  activeConnection,
  workspaceAuth,
  webApiBase,
  children,
}: {
  connection: ConnectionConfig | undefined;
  activeConnection: ConnectionConfig | undefined;
  workspaceAuth: SettingsAuth;
  webApiBase: string;
  children: ReactNode;
}) {
  if (
    window.electronAPI?.isElectron &&
    connection &&
    connection.id !== activeConnection?.id
  )
    return (
      <RemoteTarget
        key={`${connection.id}:${connection.url}:${connection.generation}`}
        connection={connection}
      >
        {children}
      </RemoteTarget>
    );
  return (
    <Context.Provider
      value={{
        connection,
        connectionId: connection?.id ?? null,
        apiBase: window.electronAPI?.isElectron
          ? (connection?.url ?? "")
          : webApiBase,
        generation: connection?.generation,
        auth: workspaceAuth,
      }}
    >
      {children}
    </Context.Provider>
  );
}
