import { Navigate, Route, Routes } from "react-router-dom";
import { useConnections } from "./features/connection/use-connections";
import { useScopedAuth } from "./features/auth/use-scoped-auth";
import { HomePage } from "./pages/home-page";
import { LoginPage } from "./pages/login-page";
import { ConnectionsPage } from "./pages/connections-page";
import { TerminalRoutePage } from "./pages/terminal-page";
import { ViewerPage } from "./pages/viewer-page";

const WEB_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";
const CONNECTIONS_STORAGE_KEY = "viewer.connections";

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      platform: string;
      backendUrl?: string;
      openExternal?: (url: string) => Promise<void>;
    };
  }
}

const isElectron = window.electronAPI?.isElectron === true;

export default function App() {
  const {
    connections,
    activeConnection,
    addConnection,
    removeConnection,
    updateConnection,
    setActive,
  } = useConnections(CONNECTIONS_STORAGE_KEY);

  const apiBase = isElectron ? (activeConnection?.url ?? "") : WEB_API_BASE;
  const activeConnectionId = isElectron ? (activeConnection?.id ?? null) : null;
  const { token, status: authStatus, setSession, clearToken } = useScopedAuth({
    apiBase,
    isElectron,
    connectionId: activeConnectionId,
    webStorageKey: AUTH_TOKEN_STORAGE_KEY,
  });

  const needsConnection = isElectron && (!activeConnection || !apiBase);
  const isAuthChecking = !needsConnection && authStatus === "checking";

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
  );
}
