import { useDesktopBadge } from "./features/attention/use-desktop-badge";
import { ResourceMonitorProvider } from "./features/system-monitor/resource-monitor-provider";
import { ResourceNotice } from "./features/system-monitor/resource-notice";
import { OverlayProvider } from "./features/overlay/provider";
import { CodexQuotaProvider } from "./features/codex-quota/provider";
import { MobileLoginProvider } from "./features/mobile-login/provider";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { TunnelDrawer } from "./features/tunnels/drawer";
import { useTunnelStore } from "./features/tunnels/store";
import { SuijiDrawer } from "./features/suiji/drawer";
import { LOCAL_DEV_CONNECTION_ID, resolveNeedsConnection } from "./features/connection/system-connection";
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
import { LoginPage } from "./pages/login-page";
import { ConnectionsPage } from "./pages/connections-page";
import { SystemMonitorPage } from "./pages/system-monitor-page";
import { TerminalRoutePage } from "./pages/terminal-page";
import { PrototypesPage } from "./pages/prototypes-page";
import { TerminalSnapshotShareNotification } from "./components/terminal/workspace/snapshot-share-notification";
import { ActivityPage } from "./pages/activity-page";
import { EvolutionPage } from "./pages/evolution-page";
import { ScheduledTasksPage } from "./pages/scheduled-tasks-page";
import { BackgroundRunPage } from "./pages/background-run-page";
import { backgroundRunPath, runDetailsPath } from "./features/scheduled-tasks/run-details-path";
import { useQuickInputNotifications } from "./features/scheduled-tasks/use-quick-input-notifications";
import { scheduledTasksApi } from "./services/scheduled-tasks";
import { HttpError } from "./services/http";
import { ClarityNavigationObserver } from "./features/analytics/clarity-navigation-observer";
import { ClarityDrawerObserver } from "./features/analytics/clarity-drawer-observer";

const WEB_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";
const CONNECTIONS_STORAGE_KEY = "viewer.connections";
const TERMINAL_LIST_PATH = "/terminal";

const isElectron = window.electronAPI?.isElectron === true;

export default function App() {
  return (
    <OverlayProvider>
      <RunweaveApp />
      <ClarityDrawerObserver />
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

  useDesktopBadge(connections);

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
  const devSessionAuthAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeConnectionId !== LOCAL_DEV_CONNECTION_ID ||
      !apiBase || token || authStatus !== "unauthenticated" ||
      !window.electronAPI?.getDevSessionAuth ||
      devSessionAuthAttempt.current === apiBase
    ) return;
    devSessionAuthAttempt.current = apiBase;
    let cancelled = false;
    void window.electronAPI.getDevSessionAuth(apiBase).then((session) => {
      if (!cancelled) setSession(session);
    }).catch(() => {
      // Shared or unavailable Backends keep the normal login page.
    });
    return () => { cancelled = true; };
  }, [activeConnectionId, apiBase, authStatus, setSession, token]);

  useEffect(() => window.electronAPI?.onResourceNotificationOpen?.((target) => {
    const connection = connections.find(item => item.id === target.connectionId);
    if (!connection) return;
    setActive(connection.id);
    navigate(`/system-monitor?app=${encodeURIComponent(target.appKey)}`);
  }), [connections, navigate, setActive]);

  const needsConnection = resolveNeedsConnection(isElectron, activeConnection);
  const isAuthChecking = !needsConnection && authStatus === "checking";
  const queryScope = buildConnectionQueryScope({
    apiBase,
    connectionId: activeConnectionId,
    generation: activeConnection?.tunnelEndpointId ? activeConnection.generation : undefined,
  });
  const [pendingScheduledRunOpen, setPendingScheduledRunOpen] = useState<{ connectionId: string; runId: string } | null>(null);
  const [scheduledRunOpenError, setScheduledRunOpenError] = useState<string | null>(null);
  const quickInputNotice = useQuickInputNotifications(
    apiBase, token, activeConnectionId,
    isElectron && authStatus !== "unauthenticated",
  );
  const requestedReturn: unknown = location.state?.scope === queryScope ? location.state?.returnTo : null;
  const loginReturnPath = typeof requestedReturn === "string" && /^\/(?:scheduled-tasks|background-runs|system-monitor)(?:\/|\?|$)/u.test(requestedReturn)
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
  useEffect(() => {
    if (!isElectron) return;
    return window.electronAPI?.onScheduledRunNotificationOpen?.((target) => {
      const connection = connections.find((item) => item.id === target.connectionId);
      if (!connection) {
        setScheduledRunOpenError("通知对应的连接已不存在，无法打开运行记录");
        return;
      }
      if (connection.available === false) {
        setScheduledRunOpenError("通知对应的连接当前不可用，请恢复连接后重试");
        return;
      }
      setScheduledRunOpenError(null);
      setPendingScheduledRunOpen(target);
      setActive(connection.id);
    });
  }, [connections, setActive]);
  useEffect(() => {
    if (!pendingScheduledRunOpen || pendingScheduledRunOpen.connectionId !== activeConnectionId) return;
    if (!token) {
      navigate("/login", { state: { scope: queryScope, returnTo: "/scheduled-tasks" } });
      return;
    }
    let cancelled = false;
    void scheduledTasksApi(apiBase, token).run(pendingScheduledRunOpen.runId)
      .then((run) => {
        if (cancelled) return;
        setPendingScheduledRunOpen(null);
        navigate(runDetailsPath(run));
      }).catch((error: unknown) => {
        if (cancelled) return;
        setPendingScheduledRunOpen(null);
        setScheduledRunOpenError(error instanceof HttpError && error.status === 404
          ? "这条运行记录已不存在，无法打开通知目标"
          : "无法读取通知对应的运行记录，请检查连接和登录状态后重试");
      });
    return () => { cancelled = true; };
  }, [activeConnectionId, apiBase, navigate, pendingScheduledRunOpen, queryScope, token]);

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
        <ResourceMonitorProvider key={`${queryScope}:${sessionId ?? ""}`} apiBase={apiBase} token={token} connectionId={activeConnectionId ?? queryScope}>
        <ResourceNotice onOpen={(appKey) => navigate(`/system-monitor?app=${encodeURIComponent(appKey)}`)} />
        <Routes>
          <Route
            path="/background-runs/:runId"
            element={needsConnection ? <Navigate to="/connections" replace /> : isAuthChecking ? authPendingView : token ? (
              <BackgroundRunPage
                apiBase={apiBase}
                token={token}
                activeConnectionId={activeConnectionId}
                activeConnectionGeneration={activeConnection?.tunnelEndpointId ? activeConnection.generation : undefined}
                connectionName={activeConnection?.name}
              />
            ) : <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search, scope: queryScope }} />}
          />
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
              needsConnection ? <Navigate to="/connections" replace /> : isAuthChecking ? authPendingView : token ? <SystemMonitorPage
                onNavigateTerminal={() => {
                  window.location.assign(TERMINAL_LIST_PATH);
                }}
              /> : <Navigate to="/login" replace state={{ returnTo: "/system-monitor", scope: queryScope }} />
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
                  onNavigateTerminal={() => window.location.assign(TERMINAL_LIST_PATH)}
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
                  onNavigateTerminal={() => window.location.assign(TERMINAL_LIST_PATH)}
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
        </ResourceMonitorProvider>
        </ConnectionQueryProvider>
        </CodexQuotaProvider>
      </RuntimeStatusProvider>
    </DevSessionBackendGuard>
  );
  return <>
    <ClarityNavigationObserver isDesktop={isElectron} needsConnection={needsConnection}
      isAuthChecking={isAuthChecking} authenticated={Boolean(token)} />
    {scheduledRunOpenError ? <button type="button" role="alert"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-rose-700 bg-card p-3 text-left text-sm shadow-lg"
      onClick={() => setScheduledRunOpenError(null)}>{scheduledRunOpenError} · 点击关闭</button> : null}
    {quickInputNotice ? <button type="button" role="status"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border bg-card p-3 text-left shadow-lg"
      onClick={() => navigate(backgroundRunPath(quickInputNotice.runId))}>
      <strong className="block text-sm">{quickInputNotice.title}</strong>
      <span className="text-xs">{quickInputNotice.body}</span>
    </button> : null}
    {isElectron && <ConnectionWorkspaceObservers connections={connections} activeConnectionId={activeConnectionId} activeToken={token} activeAuthStatus={authStatus} onActiveAuthExpired={clearToken} observeActive={location.pathname === "/connections"} />}
    {isElectron && activeConnection && token && sessionId && authStatus !== "unauthenticated"
      ? <MobileLoginProvider key={`${activeConnection.id}:${apiBase}:${sessionId}`} connection={activeConnection} token={token}>{content}</MobileLoginProvider>
      : content}
  </>;
}
