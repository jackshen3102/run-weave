import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import type {
  BackendHealthPayload,
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "@runweave/shared/runtime-monitor";
import type { SystemMonitorSnapshot } from "@runweave/shared/system-monitor";
import type {
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
} from "@runweave/shared/terminal-browser-annotation";
import type { TerminalBrowserCdpProxyInfo } from "@runweave/shared/terminal-browser-cdp-proxy";
import type {
  TerminalBrowserDevicePresetId,
  TerminalBrowserDeviceState,
} from "@runweave/shared/terminal-browser-device";
import type { TerminalBrowserDisplayScaleState } from "@runweave/shared/terminal-browser-display-scale";
import type { TerminalBrowserHeaderState } from "@runweave/shared/terminal-browser-headers";
import type { TerminalBrowserProxyState } from "@runweave/shared/terminal-browser-proxy";
import type {
  TerminalBrowserToolMenuAction,
  TerminalBrowserToolMenuRequest,
} from "@runweave/shared/terminal-browser-tool-menu";
import type {
  AttentionOpenDispatch,
  AttentionOpenIntent,
  AttentionOpenResult,
} from "@runweave/shared/attention";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import { resolveNeedsConnection } from "./features/connection/system-connection";
import { useConnections } from "./features/connection/use-connections";
import { useScopedAuth } from "./features/auth/use-scoped-auth";
import { useClientMode } from "./features/use-client-mode";
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
import { ActivityPage } from "./pages/activity-page";
import { DesktopCompanionPage } from "./pages/desktop-companion-page";
import {
  focusTerminalPanel,
  listTerminalSessions,
  updateTerminalSession,
} from "./services/terminal";
import { useTerminalPreviewStore } from "./features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "./features/terminal/workspace-store";

const WEB_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";
const CONNECTIONS_STORAGE_KEY = "viewer.connections";
const HOME_PATH = "/home";
const TERMINAL_LIST_PATH = "/terminal";
const DEV_SESSION_ID = import.meta.env.VITE_RUNWEAVE_DEV_SESSION_ID?.trim();
const EXPECTED_BACKEND_ID =
  import.meta.env.VITE_RUNWEAVE_EXPECTED_BACKEND_ID?.trim();
const EXPECTED_BACKEND_PROTOCOL = Number(
  import.meta.env.VITE_RUNWEAVE_EXPECTED_BACKEND_PROTOCOL ?? "0",
);

function waitForTerminalSessionSelection(
  terminalSessionId: string,
  projectId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const expectedPath = `/terminal/${encodeURIComponent(terminalSessionId)}`;
  const parentProjectId = resolveTerminalParentProjectId(projectId);
  return new Promise((resolve) => {
    let settled = false;
    let stableSince: number | null = null;
    const finish = (selected: boolean) => {
      if (settled) return;
      settled = true;
      window.clearInterval(stabilityTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(selected);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    const stabilityTimer = window.setInterval(() => {
      const state = useTerminalWorkspaceStore.getState();
      const matchesTarget =
        window.location.pathname === expectedPath &&
        state.activeParentProjectId === parentProjectId &&
        state.activeProjectId === projectId &&
        state.activeSessionId === terminalSessionId;
      if (!matchesTarget) {
        stableSince = null;
        return;
      }
      stableSince ??= performance.now();
      if (performance.now() - stableSince >= 100) {
        finish(true);
      }
    }, 25);
    if (signal.aborted) finish(false);
  });
}

interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  emulationScale?: number;
}

interface TerminalBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface TerminalBrowserTabSnapshot extends TerminalBrowserSnapshot {
  tabId: string;
  browserGroupId: string;
  loading: boolean;
  active: boolean;
  cdpProxyAttached: boolean;
  mcpActivityUntil: number | null;
  devtoolsOpen: boolean;
  deviceState: TerminalBrowserDeviceState;
  displayScale?: number;
}

declare global {
  interface Window {
    companionAPI?: {
      reportContentSize: (size: { width: number; height: number }) => Promise<void>;
      openSlot: (intent: AttentionOpenIntent) => Promise<AttentionOpenResult>;
      openMainWindow: () => Promise<void>;
    };
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
      reloadRuntime?: () => Promise<PackagedBackendConnectionState>;
      checkAppServer?: () => Promise<boolean>;
      openExternal?: (url: string) => Promise<void>;
      getRuntimeStats?: () => Promise<RuntimeStatsSnapshot>;
      getSystemMonitorSnapshot?: () => Promise<SystemMonitorSnapshot>;
      beep?: () => void;
      terminalBrowserNavigate?: (
        tabId: string,
        url: string,
      ) => Promise<TerminalBrowserSnapshot>;
      terminalBrowserListTabs?: () => Promise<TerminalBrowserTabSnapshot[]>;
      terminalBrowserReorderTabs?: (orderedTabIds: string[]) => Promise<void>;
      terminalBrowserReload?: (
        tabId: string,
      ) => Promise<TerminalBrowserSnapshot>;
      terminalBrowserStop?: (tabId: string) => Promise<void>;
      terminalBrowserGoBack?: (
        tabId: string,
      ) => Promise<TerminalBrowserSnapshot>;
      terminalBrowserGoForward?: (
        tabId: string,
      ) => Promise<TerminalBrowserSnapshot>;
      terminalBrowserShow?: (tabId: string) => Promise<void>;
      terminalBrowserHide?: (tabId: string) => Promise<void>;
      terminalBrowserGetDeviceState?: (
        tabId: string,
      ) => Promise<TerminalBrowserDeviceState>;
      terminalBrowserSetDeviceState?: (
        tabId: string,
        presetId: TerminalBrowserDevicePresetId,
      ) => Promise<TerminalBrowserDeviceState>;
      terminalBrowserSetDisplayScale?: (
        tabId: string,
        factor: number,
      ) => Promise<TerminalBrowserDisplayScaleState>;
      terminalBrowserSetBounds?: (
        tabId: string,
        bounds: TerminalBrowserBounds | null,
      ) => Promise<void>;
      terminalBrowserOpenDevTools?: (tabId: string) => Promise<void>;
      terminalBrowserOpenToolMenu?: (
        request: TerminalBrowserToolMenuRequest,
      ) => Promise<TerminalBrowserToolMenuAction | null>;
      terminalBrowserGetCdpProxyInfo?: (
        tabId: string,
      ) => Promise<TerminalBrowserCdpProxyInfo>;
      terminalBrowserGetProxyState?: () => Promise<TerminalBrowserProxyState>;
      terminalBrowserSetProxyEnabled?: (
        enabled: boolean,
      ) => Promise<TerminalBrowserProxyState>;
      terminalBrowserGetHeaderRules?: () => Promise<TerminalBrowserHeaderState>;
      terminalBrowserSetHeaderRules?: (
        rules: TerminalBrowserHeaderState["rules"],
      ) => Promise<TerminalBrowserHeaderState>;
      terminalBrowserCloseTab?: (tabId: string) => Promise<void>;
      terminalBrowserAnnotationStart?: (
        tabId: string,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationStop?: (
        tabId: string,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationList?: (
        tabId: string,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationSetSelecting?: (
        tabId: string,
        selecting: boolean,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationSetSubmitting?: (
        tabId: string,
        submitting: boolean,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationDelete?: (
        tabId: string,
        annotationId: string,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationFocus?: (
        tabId: string,
        annotationId: string,
      ) => Promise<TerminalBrowserAnnotationState>;
      terminalBrowserAnnotationSubmit?: (
        tabId: string,
      ) => Promise<TerminalBrowserAnnotationSubmission>;
      onTerminalBrowserTabCreatedFromProxy?: (
        listener: (data: {
          tabId: string;
          browserGroupId: string;
          url: string;
          title: string;
          openerTabId?: string;
          displayScale?: number;
        }) => void,
      ) => () => void;
      onTerminalBrowserTabUpdated?: (
        listener: (
          data: TerminalBrowserSnapshot & {
            tabId: string;
            browserGroupId: string;
            loading: boolean;
            cdpProxyAttached: boolean;
            mcpActivityUntil: number | null;
            devtoolsOpen: boolean;
            deviceState: TerminalBrowserDeviceState;
            displayScale?: number;
          },
        ) => void,
      ) => () => void;
      onTerminalBrowserTabActivatedFromProxy?: (
        listener: (
          data: TerminalBrowserSnapshot & {
            tabId: string;
            browserGroupId: string;
            loading: boolean;
            cdpProxyAttached: boolean;
            mcpActivityUntil: number | null;
            devtoolsOpen: boolean;
            deviceState: TerminalBrowserDeviceState;
            displayScale?: number;
          },
        ) => void,
      ) => () => void;
      onTerminalBrowserTabClosed?: (
        listener: (data: { tabId: string }) => void,
      ) => () => void;
      onTerminalBrowserAnnotationUpdated?: (
        listener: (data: {
          tabId: string;
          state: TerminalBrowserAnnotationState;
        }) => void,
      ) => () => void;
      onAttentionOpenIntent?: (
        listener: (intent: AttentionOpenDispatch) => void,
      ) => (() => void) | void;
      onAttentionOpenCancelled?: (
        listener: (requestId: string) => void,
      ) => (() => void) | void;
      authorizeAttentionCompletion?: (result: AttentionOpenResult) => Promise<boolean>;
      reportAttentionOpenResult?: (result: AttentionOpenResult) => Promise<void>;
    };
  }
}

const isElectron = window.electronAPI?.isElectron === true;

function DevSessionBackendGuard({ children }: { children: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(!EXPECTED_BACKEND_ID);

  useEffect(() => {
    if (!EXPECTED_BACKEND_ID) {
      return;
    }
    const controller = new AbortController();
    void fetch("/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`health returned HTTP ${response.status}`);
        }
        return (await response.json()) as BackendHealthPayload;
      })
      .then((health) => {
        const identityMatches =
          health.serviceInstanceId === EXPECTED_BACKEND_ID;
        const protocolMatches =
          (health.protocolVersion ?? 0) >= EXPECTED_BACKEND_PROTOCOL;
        if (!identityMatches || !protocolMatches) {
          throw new Error(
            `expected backend ${EXPECTED_BACKEND_ID} protocol>=${EXPECTED_BACKEND_PROTOCOL}; actual ${health.serviceInstanceId ?? "legacy"} protocol=${health.protocolVersion ?? 0}`,
          );
        }
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort();
  }, []);

  if (failure) {
    return (
      <main
        className="min-h-screen bg-background p-6 text-foreground"
        data-testid="dev-session-backend-mismatch"
      >
        <h1 className="text-lg font-semibold">Dev Session backend mismatch</h1>
        <p className="mt-2 text-sm">Session: {DEV_SESSION_ID ?? "unknown"}</p>
        <p className="mt-1 text-sm">{failure}</p>
      </main>
    );
  }
  if (!ready) {
    return (
      <main
        className="min-h-screen bg-background"
        data-testid="dev-session-backend-checking"
      />
    );
  }
  return children;
}

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
  const {
    token,
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
  });

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

  useEffect(() => {
    if (!isElectron) return;
    const inFlight = new Map<string, AbortController>();
    const unsubscribeCancelled = window.electronAPI?.onAttentionOpenCancelled?.(
      (requestId) => inFlight.get(requestId)?.abort(),
    );
    const unsubscribeIntent = window.electronAPI?.onAttentionOpenIntent?.((intent) => {
      const controller = new AbortController();
      const signal = controller.signal;
      inFlight.set(intent.requestId, controller);
      const deadlineTimer = window.setTimeout(
        () => controller.abort(),
        Math.max(0, intent.deadlineAt - Date.now()),
      );
      let completionOpenResolved = false;
      void (async () => {
        const report = async (result: AttentionOpenResult): Promise<void> => {
          if (signal.aborted) return;
          await window.electronAPI?.reportAttentionOpenResult?.(result);
        };
        if (!activeConnectionId || intent.connectionId !== activeConnectionId || !token) {
          await report({ requestId: intent.requestId, status: "connection_unavailable", message: "Connection changed before Slot opened" });
          return;
        }
        const sessions = await listTerminalSessions(apiBase, token, signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          return [];
        });
        const targetSession = sessions.find(
          (session) => session.terminalSessionId === intent.terminalSessionId,
        );
        if (!targetSession) {
          await report({ requestId: intent.requestId, status: "session_not_found", message: "Terminal Session no longer exists" });
          return;
        }
        useTerminalWorkspaceStore
          .getState()
          .selectProjectContext(
            resolveTerminalParentProjectId(targetSession.projectId),
            targetSession.projectId,
            intent.terminalSessionId,
          );
        window.history.pushState(
          null,
          "",
          `/terminal/${encodeURIComponent(intent.terminalSessionId)}`,
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
        if (
          !(await waitForTerminalSessionSelection(
            intent.terminalSessionId,
            targetSession.projectId,
            signal,
          ))
        ) {
          return;
        }
        signal.throwIfAborted();
        let panelFallback = false;
        if (intent.panelId) {
          panelFallback = await focusTerminalPanel(apiBase, token, intent.terminalSessionId, intent.panelId, signal)
            .then(() => false)
            .catch((error: unknown) => {
              if (signal.aborted) throw error;
              return true;
            });
        }
        signal.throwIfAborted();
        if (intent.targetSurface === "agent-team") {
          await updateTerminalSession(apiBase, token, intent.terminalSessionId, {
            panelSplitEnabled: true,
          }, signal);
          signal.throwIfAborted();
          useTerminalPreviewStore.getState().openAgentTeam();
        }
        signal.throwIfAborted();
        const openedResult: AttentionOpenResult = panelFallback
          ? { requestId: intent.requestId, status: "opened_with_panel_fallback", message: "Session opened; original Panel is unavailable" }
          : { requestId: intent.requestId, status: "opened" };
        if (intent.completionRevision !== null) {
          completionOpenResolved =
            (await window.electronAPI?.authorizeAttentionCompletion?.(
              openedResult,
            )) === true;
          if (!completionOpenResolved) return;
          await updateTerminalSession(apiBase, token, intent.terminalSessionId, {
            acknowledgedCompletionRevision: intent.completionRevision,
          }, signal);
          return;
        }
        signal.throwIfAborted();
        await report(openedResult);
      })().catch(async (error: unknown) => {
        if (completionOpenResolved || signal.aborted) return;
        await window.electronAPI?.reportAttentionOpenResult?.({
          requestId: intent.requestId,
          status: "session_not_found",
          message: error instanceof Error ? error.message : "Slot open failed",
        });
      }).finally(() => {
        window.clearTimeout(deadlineTimer);
        if (inFlight.get(intent.requestId) === controller) {
          inFlight.delete(intent.requestId);
        }
      });
    });
    return () => {
      unsubscribeIntent?.();
      unsubscribeCancelled?.();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    };
  }, [activeConnectionId, apiBase, token]);

  if (window.location.pathname === "/desktop-companion") {
    if (!isElectron) return <Navigate to="/" replace />;
    return (
      <DesktopCompanionPage
        apiBase={apiBase}
        token={token}
        connectionId={activeConnectionId}
      />
    );
  }

  return (
    <DevSessionBackendGuard>
      <ConnectionQueryProvider scope={queryScope} onUnauthorized={clearToken}>
        <Routes>
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
                <Navigate to={TERMINAL_LIST_PATH} replace />
              ) : (
                <LoginPage
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
            path="/terminal"
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
    </DevSessionBackendGuard>
  );
}
