import type { TerminalMobileOverviewResponse } from "@browser-viewer/shared";
import { useCallback, useEffect, useState } from "react";

import {
  login,
  logout,
  refreshSession,
  verifySession,
  type AppAuthSession,
} from "../services/auth";
import { ApiError } from "../services/http";
import { getTerminalMobileOverview } from "../services/terminal";
import { useAuthStore } from "../store/use-auth-store";

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
  overview: TerminalMobileOverviewResponse | null;
  refreshOverview: () => Promise<void>;
  startupState: StartupState;
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
    useState<TerminalMobileOverviewResponse | null>(null);
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
    try {
      const refreshed = await refreshSession(apiBase, refreshToken);
      persistSession(refreshed);
      return refreshed.accessToken;
    } catch {
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
        setOverview(await getTerminalMobileOverview(targetApiBase, token));
      } catch (nextError) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          const refreshedToken = await refreshStoredSession();
          if (!refreshedToken) {
            resetSession();
            return;
          }
          setOverview(
            await getTerminalMobileOverview(targetApiBase, refreshedToken),
          );
          return;
        }
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
        await verifySession(apiBase, accessToken);
        if (!cancelled) {
          setStartupState("ready");
          await loadOverview(accessToken);
        }
      } catch {
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
      const session = await login(apiBase, {
        username: params.username,
        password: params.password,
      });
      persistSession(session);
      await loadOverview(session.accessToken, apiBase);
    },
    [apiBase, loadOverview, persistSession],
  );

  const logoutAndReset = useCallback(() => {
    if (accessToken) {
      void logout(apiBase, accessToken).catch(() => undefined);
    }
    resetSession();
  }, [accessToken, apiBase, resetSession]);

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
