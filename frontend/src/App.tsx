import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthToken } from "./features/auth/use-auth-token";
import { useConnections } from "./features/connection/use-connections";
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
    electronAPI?: { isElectron: boolean; platform: string };
  }
}

const isElectron = window.electronAPI?.isElectron === true;

export default function App() {
  const { token, setToken, clearToken } = useAuthToken(AUTH_TOKEN_STORAGE_KEY);
  const {
    connections,
    activeConnection,
    addConnection,
    removeConnection,
    updateConnection,
    setActive,
  } = useConnections(CONNECTIONS_STORAGE_KEY);

  const apiBase = isElectron ? (activeConnection?.url ?? "") : WEB_API_BASE;

  const needsConnection = isElectron && (!activeConnection || !apiBase);

  const handleSelectConnection = (id: string) => {
    setActive(id);
    clearToken();
  };

  const handleAddConnection = (name: string, url: string) => {
    addConnection(name, url);
    clearToken();
  };

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
          ) : token ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage apiBase={apiBase} onSuccess={setToken} />
          )
        }
      />
      <Route
        path="/"
        element={
          needsConnection ? (
            <Navigate to="/connections" replace />
          ) : token ? (
            <HomePage
              apiBase={apiBase}
              token={token}
              clearToken={clearToken}
              connectionName={isElectron ? activeConnection?.name : undefined}
              onSwitchConnection={
                isElectron ? () => window.location.assign("/connections") : undefined
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
