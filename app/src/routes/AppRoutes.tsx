import { IonRouterOutlet } from "@ionic/react";
import {
  Redirect,
  Route,
  useHistory,
  useParams,
} from "react-router-dom";
import { useCallback, useMemo, type ReactElement } from "react";

import { HomePage } from "../pages/HomePage";
import { LoginPage } from "../pages/LoginPage";
import { AppTerminalPage } from "../pages/AppTerminalPage";
import type {
  AppSessionController,
  AppLoginParams,
} from "../hooks/use-app-session";
import {
  createTerminalSession,
  deleteTerminalSession,
} from "../services/terminal";

const LOGIN_ROUTE = "/login";
const HOME_ROUTE = "/home";
const TERMINAL_ROUTE = "/terminal/:terminalSessionId";

interface TerminalRouteParams {
  terminalSessionId?: string;
}

function RequireAuth({
  children,
  isAuthenticated,
}: {
  children: ReactElement;
  isAuthenticated: boolean;
}) {
  if (!isAuthenticated) {
    return <Redirect to={LOGIN_ROUTE} />;
  }
  return children;
}

function LoginRoute({ session }: { session: AppSessionController }) {
  const history = useHistory();
  const handleLogin = useCallback(
    async (params: AppLoginParams) => {
      await session.login(params);
      history.replace(HOME_ROUTE);
    },
    [history, session],
  );

  return <LoginPage onLogin={handleLogin} />;
}

function HomeRoute({ session }: { session: AppSessionController }) {
  const history = useHistory();
  const openTerminal = useCallback(
    (terminalSessionId: string) => {
      history.push(`/terminal/${encodeURIComponent(terminalSessionId)}`, {
        fromHome: true,
      });
    },
    [history],
  );
  const createTerminal = useCallback(
    async (projectId: string) => {
      const created = await createTerminalSession(
        session.apiBase,
        session.accessToken,
        { projectId },
      );
      await session.refreshOverview();
      openTerminal(created.terminalSessionId);
    },
    [openTerminal, session],
  );

  return (
    <HomePage
      apiBase={session.apiBase}
      error={session.error}
      loading={session.loading}
      onLogout={session.logout}
      onCreateTerminal={createTerminal}
      onOpenTerminal={openTerminal}
      onRefresh={session.refreshOverview}
      overview={session.overview}
    />
  );
}

function TerminalRoute({ session }: { session: AppSessionController }) {
  const history = useHistory();
  const { terminalSessionId } = useParams<TerminalRouteParams>();
  const initialSession = useMemo(
    () =>
      session.overview?.sessions.find(
        (candidate) => candidate.terminalSessionId === terminalSessionId,
      ),
    [session.overview?.sessions, terminalSessionId],
  );
  const goBack = useCallback(() => {
    void session.refreshOverview();
    history.replace(HOME_ROUTE);
  }, [history, session.refreshOverview]);
  const deleteTerminal = useCallback(async () => {
    if (!terminalSessionId) {
      return;
    }
    await deleteTerminalSession(
      session.apiBase,
      session.accessToken,
      terminalSessionId,
    );
    await session.refreshOverview();
    history.replace(HOME_ROUTE);
  }, [
    history,
    session.accessToken,
    session.apiBase,
    session.refreshOverview,
    terminalSessionId,
  ]);

  if (!terminalSessionId) {
    return <Redirect to={HOME_ROUTE} />;
  }

  return (
    <AppTerminalPage
      accessToken={session.accessToken}
      apiBase={session.apiBase}
      initialSession={initialSession}
      terminalSessionId={terminalSessionId}
      onAuthExpired={session.onAuthExpired}
      onBack={goBack}
      onDeleteTerminal={deleteTerminal}
    />
  );
}

export function AppRoutes({ session }: { session: AppSessionController }) {
  return (
    <IonRouterOutlet>
      <Route exact path={LOGIN_ROUTE}>
        {session.isAuthenticated ? (
          <Redirect to={HOME_ROUTE} />
        ) : (
          <LoginRoute session={session} />
        )}
      </Route>
      <Route exact path={HOME_ROUTE}>
        <RequireAuth isAuthenticated={session.isAuthenticated}>
          <HomeRoute session={session} />
        </RequireAuth>
      </Route>
      <Route exact path={TERMINAL_ROUTE}>
        <RequireAuth isAuthenticated={session.isAuthenticated}>
          <TerminalRoute session={session} />
        </RequireAuth>
      </Route>
      <Route exact path="/">
        <Redirect to={session.isAuthenticated ? HOME_ROUTE : LOGIN_ROUTE} />
      </Route>
      <Route>
        <Redirect to={session.isAuthenticated ? HOME_ROUTE : LOGIN_ROUTE} />
      </Route>
    </IonRouterOutlet>
  );
}
