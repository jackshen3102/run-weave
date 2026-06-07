import { IonApp } from "@ionic/react";
import { useCallback, useEffect, useState } from "react";
import type { TerminalMobileOverviewResponse } from "@browser-viewer/shared";

import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import {
  login,
  logout,
  refreshSession,
  verifySession,
  type AppAuthSession,
} from "./services/auth";
import { ApiError } from "./services/http";
import { getTerminalMobileOverview } from "./services/terminal";
import { useAuthStore } from "./store/use-auth-store";

type StartupState = "checking" | "ready";

function App() {
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
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);

  const persistSession = useCallback(
    (session: AppAuthSession) => {
      setAuthenticated(session);
    },
    [setAuthenticated],
  );

  const refreshStoredSession = useCallback(async (): Promise<string | null> => {
    if (!refreshToken) {
      return null;
    }
    try {
      const refreshed = await refreshSession(apiBase, refreshToken);
      persistSession(refreshed);
      return refreshed.accessToken;
    } catch {
      clearSession();
      return null;
    }
  }, [apiBase, clearSession, persistSession, refreshToken]);

  const loadOverview = useCallback(
    async (token = accessToken, targetApiBase = apiBase) => {
      if (!token) {
        return;
      }
      setHomeLoading(true);
      setHomeError(null);
      try {
        setOverview(await getTerminalMobileOverview(targetApiBase, token));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const refreshedToken = await refreshStoredSession();
          if (!refreshedToken) {
            clearSession();
            setOverview(null);
            return;
          }
          setOverview(
            await getTerminalMobileOverview(targetApiBase, refreshedToken),
          );
        } else {
          setHomeError(error instanceof Error ? error.message : "加载失败");
        }
      } finally {
        setHomeLoading(false);
      }
    },
    [accessToken, apiBase, clearSession, refreshStoredSession],
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

  const handleLogin = async (params: {
    username: string;
    password: string;
  }) => {
    const session = await login(apiBase, {
      username: params.username,
      password: params.password,
    });
    persistSession(session);
    await loadOverview(session.accessToken, apiBase);
  };

  const handleLogout = () => {
    if (accessToken) {
      void logout(apiBase, accessToken).catch(() => undefined);
    }
    clearSession();
    setOverview(null);
  };

  if (startupState === "checking") {
    return <IonApp className="app-loading" />;
  }

  return (
    <IonApp>
      {isAuthenticated ? (
        <HomePage
          apiBase={apiBase}
          error={homeError}
          loading={homeLoading}
          onLogout={handleLogout}
          onRefresh={loadOverview}
          overview={overview}
        />
      ) : (
        <LoginPage onLogin={handleLogin} />
      )}
    </IonApp>
  );
}

export default App;
