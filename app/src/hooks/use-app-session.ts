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
import { ApiError } from "../services/http";
import { getAppHomeOverview } from "../services/terminal";
import { useAuthStore } from "../store/use-auth-store";
import { useAppTerminalEventsConnection } from "./use-app-terminal-events-connection";

export type StartupState = "checking" | "ready";

export interface AppLoginParams {
  username: string;
  password: string;
}

export interface AppSessionController {
  accessToken: string;
  apiBase: string;
  error: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (params: AppLoginParams) => Promise<void>;
  logout: () => void;
  onAuthExpired: () => void;
  overview: AppHomeOverviewResponse | null;
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
      recordSupportLog("auth.refresh.failed", {
        error: error instanceof Error ? error.message : String(error),
      }, "warn");
      resetSession();
      return null;
    }
  }, [apiBase, persistSession, refreshToken, resetSession]);

  const loadOverview = useCallback(
    async (token = accessToken, targetApiBase = apiBase) => {
      if (!token) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setOverview(await getAppHomeOverview(targetApiBase, token));
        recordSupportLog("app.home.overview.loaded");
      } catch (nextError) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          const refreshedToken = await refreshStoredSession();
          if (!refreshedToken) {
            resetSession();
            return;
          }
          setOverview(
            await getAppHomeOverview(targetApiBase, refreshedToken),
          );
          recordSupportLog("app.home.overview.loaded_after_refresh");
          return;
        }
        recordSupportLog("app.home.overview.failed", {
          error: nextError instanceof Error ? nextError.message : String(nextError),
        }, "warn");
        setError(nextError instanceof Error ? nextError.message : "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [accessToken, apiBase, refreshStoredSession, resetSession],
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
        recordSupportLog("auth.verify.failed", {
          error: error instanceof Error ? error.message : String(error),
        }, "warn");
        const refreshedToken = await refreshStoredSession();
        if (!cancelled) {
          setStartupState("ready");
          if (refreshedToken) {
            await loadOverview(refreshedToken);
          }
        }
      }
    };

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [accessToken, apiBase, loadOverview, refreshStoredSession]);

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

  useAppTerminalEventsConnection({
    apiBase,
    accessToken,
    enabled: isAuthenticated && Boolean(accessToken),
    onAuthExpired: resetSession,
    onTerminalEvents: handleTerminalEvents,
  });

  return {
    accessToken,
    apiBase,
    error,
    isAuthenticated,
    loading,
    login: loginWithCredentials,
    logout: logoutAndReset,
    onAuthExpired: resetSession,
    overview,
    refreshOverview: loadOverview,
    startupState,
  };
}
