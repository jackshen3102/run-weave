import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "@browser-viewer/shared";
import { resolveNeedsConnection } from "./features/connection/system-connection";
import { useConnections } from "./features/connection/use-connections";
import { useScopedAuth } from "./features/auth/use-scoped-auth";
import { useClientMode } from "./features/use-client-mode";
import { HomePage } from "./pages/home-page";
import { LoginPage } from "./pages/login-page";
import { ConnectionsPage } from "./pages/connections-page";
import { TerminalRoutePage } from "./pages/terminal-page";
import { ViewerPage } from "./pages/viewer-page";
import { DiagnosticLogEntry } from "./components/diagnostic-log-entry";
import {
  DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT,
  installDiagnosticLogEntryVisibilityController,
  isDiagnosticLogEntryEnabled,
} from "./features/diagnostic-logs/entry-visibility";

const WEB_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";
const CONNECTIONS_STORAGE_KEY = "viewer.connections";

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      managesPackagedBackend?: boolean;
      platform: string;
      backendUrl?: string;
      getPackagedBackendState?: () => Promise<PackagedBackendConnectionState>;
      onPackagedBackendStateChange?: (
        listener: (state: PackagedBackendConnectionState) => void,
      ) => (() => void) | void;
      restartPackagedBackend?: () => Promise<PackagedBackendConnectionState>;
      openExternal?: (url: string) => Promise<void>;
      getRuntimeStats?: () => Promise<RuntimeStatsSnapshot>;
      beep?: () => void;
    };
  }
}

const isElectron = window.electronAPI?.isElectron === true;

export default function App() {
  const clientMode = useClientMode(isElectron);
  const {
    connections,
    activeConnection,
    addConnection,
    removeConnection,
    updateConnection,
    setActive,
    reconnectSystemConnection,
  } = useConnections(CONNECTIONS_STORAGE_KEY);

  const apiBase = isElectron ? (activeConnection?.url ?? "") : WEB_API_BASE;
  const activeConnectionId = isElectron ? (activeConnection?.id ?? null) : null;
  const { token, status: authStatus, setSession, clearToken } = useScopedAuth({
    apiBase,
    isElectron,
    connectionId: activeConnectionId,
    webStorageKey: AUTH_TOKEN_STORAGE_KEY,
  });

  const needsConnection = resolveNeedsConnection(isElectron, activeConnection);
  const isAuthChecking = !needsConnection && authStatus === "checking";
  const [diagnosticLogEntryEnabled, setDiagnosticLogEntryEnabled] = useState(
    isDiagnosticLogEntryEnabled,
  );

  useEffect(() => {
    const uninstallController =
      installDiagnosticLogEntryVisibilityController();
    const syncVisibility = () => {
      setDiagnosticLogEntryEnabled(isDiagnosticLogEntryEnabled());
    };

    window.addEventListener(
      DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT,
      syncVisibility,
    );
    window.addEventListener("storage", syncVisibility);

    return () => {
      window.removeEventListener(
        DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT,
        syncVisibility,
      );
      window.removeEventListener("storage", syncVisibility);
      uninstallController();
    };
  }, []);

  const handleSelectConnection = (id: string) => {
    setActive(id);
  };

  const handleAddConnection = (name: string, url: string) => {
    addConnection(name, url);
  };

  const openConnectionManager = () => {
    window.location.assign("/connections");
  };

  const authPendingView = <main className="min-h-screen bg-background" />;

  return (
    <>
      <Routes>
      {isElectron && (
        <Route
          path="/connections"
          element={
            <ConnectionsPage
              connections={connections}
              activeId={activeConnection?.id ?? null}
              onAdd={handleAddConnection}
              onRemove={removeConnection}
              onSelect={handleSelectConnection}
              onEdit={updateConnection}
              onReconnect={reconnectSystemConnection}
            />
          }
        />
      )}
      <Route
        path="/login"
        element={
          needsConnection ? (
            <Navigate to="/connections" replace />
          ) : isAuthChecking ? (
            authPendingView
          ) : token ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage
              apiBase={apiBase}
              connectionId={activeConnectionId ?? undefined}
              isElectron={isElectron}
              connections={connections}
              connectionName={activeConnection?.name}
              onSwitchConnection={isElectron ? handleSelectConnection : undefined}
              onOpenConnectionManager={isElectron ? openConnectionManager : undefined}
              onSuccess={setSession}
            />
          )
        }
      />
      <Route
        path="/"
        element={
          needsConnection ? (
            <Navigate to="/connections" replace />
          ) : isAuthChecking ? (
            authPendingView
          ) : token ? (
            <HomePage
              apiBase={apiBase}
              token={token}
              clientMode={clientMode}
              clearToken={clearToken}
              connections={connections}
              activeConnectionId={activeConnectionId}
              connectionName={isElectron ? activeConnection?.name : undefined}
              onSelectConnection={
                isElectron ? handleSelectConnection : undefined
              }
              onOpenConnectionManager={
                isElectron ? openConnectionManager : undefined
              }
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/viewer/:sessionId"
        element={
          needsConnection ? (
            <Navigate to="/connections" replace />
          ) : isAuthChecking ? (
            authPendingView
          ) : token ? (
            <ViewerPage
              apiBase={apiBase}
              token={token}
              clientMode={clientMode}
              onAuthExpired={clearToken}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/terminal/:terminalSessionId"
        element={
          needsConnection ? (
            <Navigate to="/connections" replace />
          ) : isAuthChecking ? (
            authPendingView
          ) : token ? (
            <TerminalRoutePage
              apiBase={apiBase}
              token={token}
              clientMode={clientMode}
              onAuthExpired={clearToken}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="*"
        element={
          <Navigate
            to={needsConnection ? "/connections" : token ? "/" : "/login"}
            replace
          />
        }
      />
      </Routes>
      {diagnosticLogEntryEnabled && !needsConnection && !isAuthChecking && token ? (
        <DiagnosticLogEntry apiBase={apiBase} token={token} />
      ) : null}
    </>
  );
}
