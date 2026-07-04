import { useMemoizedFn } from "ahooks";
import type {
  AppHomeOverviewResponse,
  AppHomeOverviewSession,
  TerminalEventEnvelope,
  TerminalState,
} from "@runweave/shared";
import { useEffect, useRef, useState } from "react";

import type { AppConnectionConfig } from "../features/connections/types";
import { recordSupportLog } from "../features/support-logs";
import {
  login,
  logout,
  refreshSession,
  verifySession,
  type AppAuthSession,
} from "../services/auth";
import { classifyApiFailure } from "../services/api-failure";
import { getAppHomeOverview } from "../services/terminal";
import { useAppConnectionStore } from "../store/use-app-connection-store";
import { useAuthStore } from "../store/use-auth-store";
import { useAppDeviceConnection } from "./use-app-device-connection";
import type { AppDeviceConnectionSnapshot } from "./use-app-device-connection";
import { useAppTerminalEventsConnection } from "./use-app-terminal-events-connection";

export type StartupState = "checking" | "ready";

export interface AppLoginParams {
  username: string;
  password: string;
}

export interface AppSessionController {
  accessToken: string;
  activeConnection: AppConnectionConfig | null;
  apiBase: string;
  deviceConnection: AppDeviceConnectionSnapshot;
  error: string | null;
  hasActiveConnection: boolean;
  isAuthenticated: boolean;
  loading: boolean;
  login: (params: AppLoginParams) => Promise<void>;
  logout: () => void;
  onAuthExpired: () => void;
  overview: AppHomeOverviewResponse | null;
  refreshDeviceConnection: () => Promise<AppDeviceConnectionSnapshot>;
  refreshOverview: () => Promise<void>;
  startupState: StartupState;
}

function resolveSessionDisplayStatus(
  session: AppHomeOverviewSession,
  terminalState: TerminalState,
): Pick<AppHomeOverviewSession, "displayStatus" | "displayStatusLabel"> {
  if (session.status === "exited") {
    return {
      displayStatus: "exited",
      displayStatusLabel: "Exited",
    };
  }

  if (terminalState.state === "agent_running") {
    return {
      displayStatus: "running",
      displayStatusLabel: "Agent Running",
    };
  }

  if (terminalState.state === "agent_starting") {
    return {
      displayStatus: "agent-starting",
      displayStatusLabel: "Agent Starting",
    };
  }

  if (terminalState.state === "agent_idle") {
    return {
      displayStatus: "agent-idle",
      displayStatusLabel: "Agent Idle",
    };
  }

  return {
    displayStatus: "idle",
    displayStatusLabel: "Idle",
  };
}

function isOverviewInvalidationEvent(event: TerminalEventEnvelope): boolean {
  return (
    event.kind === "project_created" ||
    event.kind === "project_deleted" ||
    event.kind === "terminal_session_created" ||
    event.kind === "terminal_session_deleted"
  );
}

function supportConnectionFields(connection: AppConnectionConfig | null) {
  return {
    connectionId: connection?.id ?? null,
    connectionName: connection?.name ?? null,
  };
}

export function useAppSession(): AppSessionController {
  const activeConnection = useAppConnectionStore(
    (state) => state.activeConnection,
  );
  const activeConnectionId = activeConnection?.id ?? null;
  const apiBase = activeConnection?.url ?? "";
  const activeConnectionIdRef = useRef<string | null>(activeConnectionId);
  const {
    accessToken,
    refreshToken,
    activeConnectionId: authConnectionId,
    isAuthenticated,
    isSessionLoading,
    sessionError,
    loadSessionForConnection,
    setAuthenticated,
    clearSession,
  } = useAuthStore();
  const scopedAccessToken =
    authConnectionId === activeConnectionId ? accessToken : "";
  const scopedRefreshToken =
    authConnectionId === activeConnectionId ? refreshToken : "";
  const scopedIsAuthenticated =
    authConnectionId === activeConnectionId && isAuthenticated;
  const [startupState, setStartupState] = useState<StartupState>("checking");
  const [overview, setOverview] = useState<AppHomeOverviewResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    deviceConnection,
    markDeviceOnline,
    refreshDeviceConnection,
  } = useAppDeviceConnection({
    apiBase,
    connectionId: activeConnectionId,
    enabled: Boolean(activeConnectionId),
  });

  useEffect(() => {
    activeConnectionIdRef.current = activeConnectionId;
  }, [activeConnectionId]);

  useEffect(() => {
    let cancelled = false;
    setStartupState("checking");
    setOverview(null);
    setError(null);
    setLoading(false);
    void loadSessionForConnection(activeConnectionId).finally(() => {
      if (!cancelled) {
        setStartupState("ready");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeConnectionId, loadSessionForConnection]);

  useEffect(() => {
    if (sessionError) {
      setError(sessionError);
    }
  }, [sessionError]);

  const persistSession = useMemoizedFn(
    async (connectionId: string, session: AppAuthSession) => {
      await setAuthenticated(connectionId, session);
    },
  );

  const resetSession = useMemoizedFn(async () => {
    const connectionId = activeConnectionIdRef.current;
    await clearSession(connectionId);
    setOverview(null);
  });

  const refreshStoredSession = useMemoizedFn(
    async (): Promise<string | null> => {
      const connectionId = activeConnectionIdRef.current;
      if (!connectionId || !scopedRefreshToken) {
        return null;
      }
      recordSupportLog(
        "auth.refresh.started",
        supportConnectionFields(activeConnection),
      );
      try {
        const refreshed = await refreshSession(apiBase, scopedRefreshToken);
        await persistSession(connectionId, refreshed);
        recordSupportLog(
          "auth.refresh.completed",
          supportConnectionFields(activeConnection),
        );
        return refreshed.accessToken;
      } catch (error) {
        const failure = classifyApiFailure(error);
        recordSupportLog(
          "auth.refresh.failed",
          {
            ...supportConnectionFields(activeConnection),
            failureKind: failure.kind,
            error: error instanceof Error ? error.message : String(error),
          },
          "warn",
        );
        if (failure.kind === "auth-expired") {
          await resetSession();
        } else {
          void refreshDeviceConnection();
        }
        return null;
      }
    },
  );

  const loadOverview = useMemoizedFn(
    async (
      token = scopedAccessToken,
      targetApiBase = apiBase,
      targetConnectionId = activeConnectionId,
    ) => {
      if (!token || !targetConnectionId) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const nextOverview = await getAppHomeOverview(targetApiBase, token);
        if (activeConnectionIdRef.current !== targetConnectionId) {
          return;
        }
        setOverview(nextOverview);
        markDeviceOnline("health-ok");
        recordSupportLog(
          "app.home.overview.loaded",
          supportConnectionFields(activeConnection),
        );
      } catch (nextError) {
        if (activeConnectionIdRef.current !== targetConnectionId) {
          return;
        }
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          const refreshedToken = await refreshStoredSession();
          if (!refreshedToken) {
            return;
          }
          try {
            const nextOverview = await getAppHomeOverview(
              targetApiBase,
              refreshedToken,
            );
            if (activeConnectionIdRef.current !== targetConnectionId) {
              return;
            }
            setOverview(nextOverview);
            markDeviceOnline("health-ok");
            recordSupportLog(
              "app.home.overview.loaded_after_refresh",
              supportConnectionFields(activeConnection),
            );
          } catch (refreshError) {
            if (activeConnectionIdRef.current !== targetConnectionId) {
              return;
            }
            const refreshFailure = classifyApiFailure(refreshError);
            if (refreshFailure.kind === "auth-expired") {
              await resetSession();
              return;
            }
            void refreshDeviceConnection();
            setError("本地电脑暂时不可用");
          }
          return;
        }
        recordSupportLog(
          "app.home.overview.failed",
          {
            ...supportConnectionFields(activeConnection),
            failureKind: failure.kind,
            error:
              nextError instanceof Error
                ? nextError.message
                : String(nextError),
          },
          "warn",
        );
        void refreshDeviceConnection();
        setError("本地电脑暂时不可用");
      } finally {
        if (activeConnectionIdRef.current === targetConnectionId) {
          setLoading(false);
        }
      }
    },
  );

  useEffect(() => {
    let cancelled = false;
    const checkSession = async () => {
      if (!activeConnectionId || isSessionLoading) {
        return;
      }
      if (!scopedAccessToken) {
        return;
      }

      try {
        recordSupportLog(
          "auth.verify.started",
          supportConnectionFields(activeConnection),
        );
        await verifySession(apiBase, scopedAccessToken);
        if (
          !cancelled &&
          activeConnectionIdRef.current === activeConnectionId
        ) {
          recordSupportLog(
            "auth.verify.completed",
            supportConnectionFields(activeConnection),
          );
          await loadOverview(scopedAccessToken, apiBase, activeConnectionId);
        }
      } catch (error) {
        if (cancelled || activeConnectionIdRef.current !== activeConnectionId) {
          return;
        }
        const failure = classifyApiFailure(error);
        recordSupportLog(
          "auth.verify.failed",
          {
            ...supportConnectionFields(activeConnection),
            failureKind: failure.kind,
            error: error instanceof Error ? error.message : String(error),
          },
          "warn",
        );
        if (failure.kind === "auth-expired") {
          const refreshedToken = await refreshStoredSession();
          if (!cancelled && refreshedToken) {
            await loadOverview(refreshedToken, apiBase, activeConnectionId);
          }
          return;
        }
        void refreshDeviceConnection();
      }
    };

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [
    activeConnection,
    activeConnectionId,
    apiBase,
    isSessionLoading,
    loadOverview,
    refreshDeviceConnection,
    refreshStoredSession,
    scopedAccessToken,
  ]);

  const refreshOverview = useMemoizedFn(async () => {
    if (deviceConnection.status === "offline") {
      const snapshot = await refreshDeviceConnection();
      if (snapshot.status === "offline") {
        setError("本地电脑暂时不可用");
        return;
      }
    }
    await loadOverview();
  });

  const loginWithCredentials = useMemoizedFn(async (params: AppLoginParams) => {
    if (!activeConnectionId) {
      throw new Error("请先添加并选择一个后端连接");
    }
    recordSupportLog("auth.login.started", {
      ...supportConnectionFields(activeConnection),
      usernameLength: params.username.length,
    });
    try {
      const session = await login(apiBase, {
        username: params.username,
        password: params.password,
      });
      await persistSession(activeConnectionId, session);
      recordSupportLog(
        "auth.login.completed",
        supportConnectionFields(activeConnection),
      );
      await loadOverview(session.accessToken, apiBase, activeConnectionId);
    } catch (error) {
      recordSupportLog(
        "auth.login.failed",
        {
          ...supportConnectionFields(activeConnection),
          error: error instanceof Error ? error.message : String(error),
        },
        "warn",
      );
      throw error;
    }
  });

  const logoutAndReset = useMemoizedFn(() => {
    const connectionId = activeConnectionIdRef.current;
    recordSupportLog(
      "auth.logout.started",
      supportConnectionFields(activeConnection),
    );
    if (scopedAccessToken) {
      void logout(apiBase, scopedAccessToken).catch(() => undefined);
    }
    void clearSession(connectionId);
    setOverview(null);
    recordSupportLog(
      "auth.logout.completed",
      supportConnectionFields(activeConnection),
    );
  });

  const handleAuthExpired = useMemoizedFn(() => {
    void resetSession();
  });

  const handleTerminalEvents = useMemoizedFn(
    (events: TerminalEventEnvelope[]) => {
      const stateEvents = events.filter(
        (event) => event.kind === "terminal_state_changed",
      );
      if (events.some(isOverviewInvalidationEvent)) {
        void loadOverview();
      }
      if (stateEvents.length === 0) {
        return;
      }

      setOverview((currentOverview) => {
        if (!currentOverview) {
          return currentOverview;
        }

        let changed = false;
        const nextStateBySessionId = new Map(
          stateEvents.map((event) => [
            event.terminalSessionId,
            event.payload.next,
          ]),
        );
        const nextSessions = currentOverview.sessions.map((session) => {
          const terminalState = nextStateBySessionId.get(
            session.terminalSessionId,
          );
          if (!terminalState) {
            return session;
          }

          const displayStatus = resolveSessionDisplayStatus(
            session,
            terminalState,
          );
          if (
            session.terminalState.state === terminalState.state &&
            session.terminalState.agent === terminalState.agent &&
            session.displayStatus === displayStatus.displayStatus &&
            session.displayStatusLabel === displayStatus.displayStatusLabel
          ) {
            return session;
          }

          changed = true;
          return {
            ...session,
            ...displayStatus,
            terminalState,
          };
        });

        return changed
          ? {
              ...currentOverview,
              sessions: nextSessions,
            }
          : currentOverview;
      });
    },
  );

  const handleTerminalEventsTransportFailure = useMemoizedFn(async () => {
    const snapshot = await refreshDeviceConnection();
    return snapshot.status !== "offline";
  });

  useAppTerminalEventsConnection({
    apiBase,
    accessToken: scopedAccessToken,
    enabled:
      Boolean(activeConnectionId) &&
      scopedIsAuthenticated &&
      Boolean(scopedAccessToken) &&
      deviceConnection.status === "online",
    onAuthExpired: () => void resetSession(),
    onConnectionClose: handleTerminalEventsTransportFailure,
    onConnectionError: handleTerminalEventsTransportFailure,
    onServerConnected: () => markDeviceOnline("terminal-events-connected"),
    onTerminalEvents: handleTerminalEvents,
  });

  return {
    accessToken: scopedAccessToken,
    activeConnection,
    apiBase,
    deviceConnection,
    error,
    hasActiveConnection: Boolean(activeConnectionId),
    isAuthenticated: scopedIsAuthenticated,
    loading,
    login: loginWithCredentials,
    logout: logoutAndReset,
    onAuthExpired: handleAuthExpired,
    overview,
    refreshDeviceConnection,
    refreshOverview,
    startupState,
  };
}
