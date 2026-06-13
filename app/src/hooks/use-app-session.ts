import type {
  AppHomeOverviewResponse,
  AppHomeOverviewSession,
  TerminalEventEnvelope,
  TerminalState,
} from "@browser-viewer/shared";
import { useCallback, useEffect, useState } from "react";

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
  apiBase: string;
  deviceConnection: AppDeviceConnectionSnapshot;
  error: string | null;
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

export function useAppSession(): AppSessionController {
  const {
    apiBase,
    accessToken,
    refreshToken,
    isAuthenticated,
    setAuthenticated,
    clearSession,
  } = useAuthStore();
  const [startupState, setStartupState] = useState<StartupState>("checking");
  const [overview, setOverview] =
    useState<AppHomeOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    deviceConnection,
    markDeviceOnline,
    markDeviceOffline,
    refreshDeviceConnection,
  } = useAppDeviceConnection({
    apiBase,
    enabled: isAuthenticated && Boolean(accessToken),
  });

  const persistSession = useCallback(
    (session: AppAuthSession) => {
      setAuthenticated(session);
    },
    [setAuthenticated],
  );

  const resetSession = useCallback(() => {
    clearSession();
    setOverview(null);
  }, [clearSession]);

  const refreshStoredSession = useCallback(async (): Promise<string | null> => {
    if (!refreshToken) {
      return null;
    }
    recordSupportLog("auth.refresh.started");
    try {
      const refreshed = await refreshSession(apiBase, refreshToken);
      persistSession(refreshed);
      recordSupportLog("auth.refresh.completed");
      return refreshed.accessToken;
    } catch (error) {
      const failure = classifyApiFailure(error);
      recordSupportLog("auth.refresh.failed", {
        failureKind: failure.kind,
        error: error instanceof Error ? error.message : String(error),
      }, "warn");
      if (failure.kind === "auth-expired") {
        resetSession();
      } else {
        markDeviceOffline("network-unreachable", "本地电脑暂时不可用");
      }
      return null;
    }
  }, [
    apiBase,
    markDeviceOffline,
    persistSession,
    refreshToken,
    resetSession,
  ]);

  const loadOverview = useCallback(
    async (token = accessToken, targetApiBase = apiBase) => {
      if (!token) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setOverview(await getAppHomeOverview(targetApiBase, token));
        markDeviceOnline("health-ok");
        recordSupportLog("app.home.overview.loaded");
      } catch (nextError) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          const refreshedToken = await refreshStoredSession();
          if (!refreshedToken) {
            return;
          }
          try {
            setOverview(
              await getAppHomeOverview(targetApiBase, refreshedToken),
            );
            markDeviceOnline("health-ok");
            recordSupportLog("app.home.overview.loaded_after_refresh");
          } catch (refreshError) {
            const refreshFailure = classifyApiFailure(refreshError);
            if (refreshFailure.kind === "auth-expired") {
              resetSession();
              return;
            }
            markDeviceOffline("network-unreachable", "本地电脑暂时不可用");
            setError("本地电脑暂时不可用");
          }
          return;
        }
        recordSupportLog("app.home.overview.failed", {
          failureKind: failure.kind,
          error: nextError instanceof Error ? nextError.message : String(nextError),
        }, "warn");
        markDeviceOffline("network-unreachable", "本地电脑暂时不可用");
        setError("本地电脑暂时不可用");
      } finally {
        setLoading(false);
      }
    },
    [
      accessToken,
      apiBase,
      markDeviceOffline,
      markDeviceOnline,
      refreshStoredSession,
      resetSession,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    const checkSession = async () => {
      if (!accessToken) {
        if (!cancelled) {
          setStartupState("ready");
        }
        return;
      }

      try {
        recordSupportLog("auth.verify.started");
        await verifySession(apiBase, accessToken);
        if (!cancelled) {
          recordSupportLog("auth.verify.completed");
          setStartupState("ready");
          await loadOverview(accessToken);
        }
      } catch (error) {
        const failure = classifyApiFailure(error);
        recordSupportLog("auth.verify.failed", {
          failureKind: failure.kind,
          error: error instanceof Error ? error.message : String(error),
        }, "warn");
        if (failure.kind === "auth-expired") {
          const refreshedToken = await refreshStoredSession();
          if (!cancelled) {
            setStartupState("ready");
            if (refreshedToken) {
              await loadOverview(refreshedToken);
            }
          }
          return;
        }
        markDeviceOffline("network-unreachable", "本地电脑暂时不可用");
        if (!cancelled) {
          setStartupState("ready");
        }
      }
    };

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [accessToken, apiBase, loadOverview, refreshStoredSession]);

  const refreshOverview = useCallback(async () => {
    if (deviceConnection.status === "offline") {
      const snapshot = await refreshDeviceConnection();
      if (snapshot.status === "offline") {
        setError("本地电脑暂时不可用");
        return;
      }
    }
    await loadOverview();
  }, [deviceConnection.status, loadOverview, refreshDeviceConnection]);

  const loginWithCredentials = useCallback(
    async (params: AppLoginParams) => {
      recordSupportLog("auth.login.started", {
        usernameLength: params.username.length,
      });
      try {
        const session = await login(apiBase, {
          username: params.username,
          password: params.password,
        });
        persistSession(session);
        recordSupportLog("auth.login.completed");
        await loadOverview(session.accessToken, apiBase);
      } catch (error) {
        recordSupportLog("auth.login.failed", {
          error: error instanceof Error ? error.message : String(error),
        }, "warn");
        throw error;
      }
    },
    [apiBase, loadOverview, persistSession],
  );

  const logoutAndReset = useCallback(() => {
    recordSupportLog("auth.logout.started");
    if (accessToken) {
      void logout(apiBase, accessToken).catch(() => undefined);
    }
    resetSession();
    recordSupportLog("auth.logout.completed");
  }, [accessToken, apiBase, resetSession]);

  const handleTerminalEvents = useCallback((events: TerminalEventEnvelope[]) => {
    const stateEvents = events.filter(
      (event) => event.kind === "terminal_state_changed",
    );
    if (stateEvents.length === 0) {
      return;
    }

    setOverview((currentOverview) => {
      if (!currentOverview) {
        return currentOverview;
      }

      let changed = false;
      const nextStateBySessionId = new Map(
        stateEvents.map((event) => [event.terminalSessionId, event.payload.next]),
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
  }, []);

  const handleTerminalEventsTransportFailure = useCallback(async () => {
    const snapshot = await refreshDeviceConnection();
    return snapshot.status !== "offline";
  }, [refreshDeviceConnection]);

  useAppTerminalEventsConnection({
    apiBase,
    accessToken,
    enabled:
      isAuthenticated &&
      Boolean(accessToken) &&
      deviceConnection.status === "online",
    onAuthExpired: resetSession,
    onConnectionClose: handleTerminalEventsTransportFailure,
    onConnectionError: handleTerminalEventsTransportFailure,
    onServerConnected: () => markDeviceOnline("terminal-events-connected"),
    onTerminalEvents: handleTerminalEvents,
  });

  return {
    accessToken,
    apiBase,
    deviceConnection,
    error,
    isAuthenticated,
    loading,
    login: loginWithCredentials,
    logout: logoutAndReset,
    onAuthExpired: resetSession,
    overview,
    refreshDeviceConnection,
    refreshOverview,
    startupState,
  };
}
