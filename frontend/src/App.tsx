import { OverlayProvider } from "./features/overlay/provider";
import { CodexQuotaProvider } from "./features/codex-quota/provider";
import { MobileLoginProvider } from "./features/mobile-login/provider";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { TunnelDrawer } from "./features/tunnels/drawer";
import { useTunnelStore } from "./features/tunnels/store";
import { SuijiDrawer } from "./features/suiji/drawer";
import { resolveNeedsConnection } from "./features/connection/system-connection";
import { useConnections } from "./features/connection/use-connections";
import { ConnectionWorkspaceObservers } from "./features/connection/workspace-overview";
import { setTerminalNavigation } from "./features/terminal/state/navigation";
import { RemoteConnectionInterrupted } from "./features/connection/remote-connection-interrupted";
import { useScopedAuth } from "./features/auth/use-scoped-auth";
import { useAttentionOpenIntents } from "./features/attention/use-attention-open-intents";
import { useDesktopCompanionHost } from "./features/attention/use-desktop-companion-host";
import { DevSessionBackendGuard } from "./features/dev-session-backend-guard";
import { useClientMode } from "./features/use-client-mode";
import { RuntimeStatusProvider } from "./features/runtime-status/provider";
import {
  buildConnectionQueryScope,
  ConnectionQueryProvider,
} from "./features/query/connection-query-provider";
import { HomePage } from "./pages/home-page";
import { LoginPage } from "./pages/login-page";
import { ConnectionsPage } from "./pages/connections-page";
import { SystemMonitorPage } from "./pages/system-monitor-page";
import { TerminalRoutePage } from "./pages/terminal-page";
import { PrototypesPage } from "./pages/prototypes-page";
import { TerminalSnapshotShareNotification } from "./components/terminal/workspace/snapshot-share-notification";
import { ActivityPage } from "./pages/activity-page";
import { EvolutionPage } from "./pages/evolution-page";
import { ScheduledTasksPage } from "./pages/scheduled-tasks-page";

const WEB_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";
const CONNECTIONS_STORAGE_KEY = "viewer.connections";
const HOME_PATH = "/home";
const TERMINAL_LIST_PATH = "/terminal";

const isElectron = window.electronAPI?.isElectron === true;

export default function App() {
  return (
    <OverlayProvider>
      <RunweaveApp />
      <SuijiDrawer />
      <TunnelDrawer />
      <TerminalSnapshotShareNotification />
    </OverlayProvider>
  );
}

function RunweaveApp() {
  const location = useLocation();
  const navigate = useNavigate();
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
  const {
    token,
    sessionId,
    status: authStatus,
    setSession,
    clearToken,
  } = useScopedAuth({
    apiBase,
    isElectron,
    connectionId: activeConnectionId,
    webStorageKey: AUTH_TOKEN_STORAGE_KEY,
  });

  const needsConnection = resolveNeedsConnection(isElectron, activeConnection);
  const isAuthChecking = !needsConnection && authStatus === "checking";
  const queryScope = buildConnectionQueryScope({
    apiBase,
    connectionId: activeConnectionId,
    generation: activeConnection?.tunnelEndpointId ? activeConnection.generation : undefined,
  });
  const requestedReturn: unknown = location.state?.scope === queryScope ? location.state?.returnTo : null;
  const loginReturnPath = typeof requestedReturn === "string" && /^\/scheduled-tasks(?:\/|\?|$)/u.test(requestedReturn)
    ? requestedReturn : TERMINAL_LIST_PATH;

  const handleSelectConnection = (id: string) => {
    setActive(id);
  };

  useEffect(() => {
    if (!isElectron) return;
    return window.electronAPI?.onAttentionNotificationOpen?.((target) => {
      const connection = connections.find((item) => item.id === target.connectionId);
      if (!connection || connection.available === false) return;
      setTerminalNavigation(buildConnectionQueryScope({ apiBase: connection.url, connectionId: connection.id, generation: connection.tunnelEndpointId ? connection.generation : undefined }), {
        parentProjectId: target.parentProjectId,
        projectId: target.projectId,
        terminalSessionId: target.terminalSessionId,
        ...(target.panelId ? { panelId: target.panelId } : {}),
      });
      setActive(connection.id);
      navigate(`/terminal/${encodeURIComponent(target.terminalSessionId)}`);
    });
  }, [connections, navigate, setActive]);

  const handleAddConnection = (name: string, url: string, endpointId?: string) => {
    addConnection(name, url, endpointId);
  };

  const openConnectionManager = () => {
    window.location.assign("/connections");
  };

  const authPendingView = <main className="min-h-screen bg-background" />;

  useAttentionOpenIntents({
    activeConnectionId,
    apiBase,
    enabled: isElectron,
    token,
  });
  useDesktopCompanionHost({
    apiBase,
    token,
    connectionId: activeConnectionId,
    enabled: isElectron,
  });

  const content = (
    <DevSessionBackendGuard>
      <RuntimeStatusProvider
        apiBase={apiBase}
        token={token}
        connections={connections}
        isElectron={isElectron}
      >
        <CodexQuotaProvider key={`${queryScope}:${sessionId ?? ""}:${token ? "authenticated" : "anonymous"}`} apiBase={apiBase} token={token} connectionName={activeConnection?.name ?? "当前连接"} onUnauthorized={clearToken}>
        <ConnectionQueryProvider scope={queryScope} onUnauthorized={clearToken}>
        <Routes>
          <Route
            path="/scheduled-tasks/:taskId?"
            element={needsConnection ? <Navigate to="/connections" replace /> : isAuthChecking ? authPendingView : token ? (
              <ScheduledTasksPage
                apiBase={apiBase}
                token={token}
                activeConnectionId={activeConnectionId}
                activeConnectionGeneration={activeConnection?.tunnelEndpointId ? activeConnection.generation : undefined}
                connectionName={activeConnection?.name}
                connections={connections}
                onSelectConnection={isElectron ? handleSelectConnection : undefined}
                onOpenConnectionManager={isElectron ? openConnectionManager : undefined}
              />
            ) : <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search, scope: queryScope }} />}
          />
          <Route
            path="/system-monitor"
            element={
              <SystemMonitorPage
                onNavigateHome={() => {
                  window.location.assign(HOME_PATH);
                }}
              />
            }
          />
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
                <Navigate to={loginReturnPath} replace />
              ) : (
                <LoginPage
                  returnTo={loginReturnPath}
                  apiBase={apiBase}
                  connectionId={activeConnectionId ?? undefined}
                  isElectron={isElectron}
                  connections={connections}
                  connectionName={activeConnection?.name}
                  onSwitchConnection={
                    isElectron ? handleSelectConnection : undefined
                  }
                  onOpenConnectionManager={
                    isElectron ? openConnectionManager : undefined
                  }
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
                <Navigate to={TERMINAL_LIST_PATH} replace />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path={HOME_PATH}
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
                  connectionName={
                    isElectron ? activeConnection?.name : undefined
                  }
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
            path="/activity"
            element={
              needsConnection ? (
                <Navigate to="/connections" replace />
              ) : isAuthChecking ? (
                authPendingView
              ) : token ? (
                <ActivityPage
                  apiBase={apiBase}
                  token={token}
                  onNavigateHome={() => window.location.assign(HOME_PATH)}
                />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="/evolution"
            element={
              needsConnection ? (
                <Navigate to="/connections" replace />
              ) : isAuthChecking ? (
                authPendingView
              ) : token ? (
                <EvolutionPage
                  apiBase={apiBase}
                  token={token}
                  onNavigateHome={() => window.location.assign(HOME_PATH)}
                />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="/terminal"
            element={
              needsConnection ? (
                activeConnection?.tunnelEndpointId ? <RemoteConnectionInterrupted connection={activeConnection} connections={connections} onSelectConnection={handleSelectConnection} onOpenConnectionManager={openConnectionManager} onReconnect={() => useTunnelStore.getState().setOpen(true)} /> : <Navigate to="/connections" replace />
              ) : isAuthChecking ? (
                authPendingView
              ) : token ? (
                <TerminalRoutePage
                  apiBase={apiBase}
                  token={token}
                  clientMode={clientMode}
                  connections={connections}
                  activeConnectionId={activeConnectionId}
                  connectionName={
                    isElectron ? activeConnection?.name : undefined
                  }
                  activeConnection={activeConnection}
                  onSelectConnection={
                    isElectron ? handleSelectConnection : undefined
                  }
                  onOpenConnectionManager={
                    isElectron ? openConnectionManager : undefined
                  }
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
                activeConnection?.tunnelEndpointId ? <RemoteConnectionInterrupted connection={activeConnection} connections={connections} onSelectConnection={handleSelectConnection} onOpenConnectionManager={openConnectionManager} onReconnect={() => useTunnelStore.getState().setOpen(true)} /> : <Navigate to="/connections" replace />
              ) : isAuthChecking ? (
                authPendingView
              ) : token ? (
                <TerminalRoutePage
                  apiBase={apiBase}
                  token={token}
                  clientMode={clientMode}
                  connections={connections}
                  activeConnectionId={activeConnectionId}
                  connectionName={
                    isElectron ? activeConnection?.name : undefined
                  }
                  activeConnection={activeConnection}
                  onSelectConnection={
                    isElectron ? handleSelectConnection : undefined
                  }
                  onOpenConnectionManager={
                    isElectron ? openConnectionManager : undefined
                  }
                  onAuthExpired={clearToken}
                />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="/prototypes"
            element={
              needsConnection ? (
                <Navigate to="/connections" replace />
              ) : isAuthChecking ? (
                authPendingView
              ) : token ? (
                <PrototypesPage
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
            path="/prototypes/:projectId/:prototypeSource/:prototypeSlug"
            element={
              needsConnection ? (
                <Navigate to="/connections" replace />
              ) : isAuthChecking ? (
                authPendingView
              ) : token ? (
                <PrototypesPage
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
                to={
                  needsConnection
                    ? "/connections"
                    : token
                      ? TERMINAL_LIST_PATH
                      : "/login"
                }
                replace
              />
            }
          />
        </Routes>
        </ConnectionQueryProvider>
        </CodexQuotaProvider>
      </RuntimeStatusProvider>
    </DevSessionBackendGuard>
  );
  return <>
    {isElectron && <ConnectionWorkspaceObservers connections={connections} activeConnectionId={activeConnectionId} activeToken={token} activeAuthStatus={authStatus} onActiveAuthExpired={clearToken} observeActive={location.pathname === "/connections"} />}
    {isElectron && activeConnection && token && sessionId && authStatus !== "unauthenticated"
      ? <MobileLoginProvider key={`${activeConnection.id}:${apiBase}:${sessionId}`} connection={activeConnection} token={token}>{content}</MobileLoginProvider>
      : content}
  </>;
}
