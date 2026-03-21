import { useEffect, useState } from "react";
import type { SessionListItem } from "@browser-viewer/shared";
import { ThemeToggle } from "./components/theme-toggle";
import { Button } from "./components/ui/button";
import { ViewerPage } from "./components/viewer-page";
import { LoginPage } from "./components/login-page";
import { useAuthToken } from "./features/auth/use-auth-token";
import { HttpError } from "./services/http";
import {
  createSession as createViewerSession,
  deleteSession as deleteViewerSession,
  listSessions as fetchSessionList,
} from "./services/session";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";

export default function App() {
  const [url, setUrl] = useState("https://www.google.cn");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const { token, setToken, clearToken } = useAuthToken(AUTH_TOKEN_STORAGE_KEY);

  const searchParams = new URLSearchParams(window.location.search);
  const viewerSessionId = searchParams.get("sessionId");

  const setTokenAndPersist = (nextToken: string): void => {
    setToken(nextToken);
    setError(null);
  };

  const loadSessions = async (): Promise<void> => {
    if (!token) {
      return;
    }

    setLoadingSessions(true);
    try {
      const items = await fetchSessionList(API_BASE, token);
      setSessions(items);
    } catch (listError) {
      if (listError instanceof HttpError && listError.status === 401) {
        clearToken();
        return;
      }
      setError(String(listError));
    } finally {
      setLoadingSessions(false);
    }
  };

  useEffect(() => {
    if (viewerSessionId) {
      return;
    }
    void loadSessions();
  }, [token, viewerSessionId]);

  const enterSession = (sessionId: string): void => {
    window.location.assign(`/?sessionId=${encodeURIComponent(sessionId)}`);
  };

  const removeSession = async (sessionId: string): Promise<void> => {
    if (!token) {
      return;
    }

    setDeletingSessionId(sessionId);
    setError(null);
    try {
      await deleteViewerSession(API_BASE, token, sessionId);
      await loadSessions();
    } catch (deleteError) {
      if (deleteError instanceof HttpError && deleteError.status === 401) {
        clearToken();
        return;
      }
      setError(String(deleteError));
    } finally {
      setDeletingSessionId(null);
    }
  };

  const formatDateTime = (isoTime: string): string => {
    return new Date(isoTime).toLocaleString();
  };

  const createSession = async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      if (!token) {
        clearToken();
        return;
      }

      const data = await createViewerSession(API_BASE, { url }, token);
      await loadSessions();
      enterSession(data.sessionId);
    } catch (createError) {
      if (createError instanceof HttpError) {
        if (createError.status === 401) {
          clearToken();
          return;
        }
      }
      setError(String(createError));
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return <LoginPage apiBase={API_BASE} onSuccess={setTokenAndPersist} />;
  }

  if (viewerSessionId) {
    return (
      <ViewerPage
        apiBase={API_BASE}
        sessionId={viewerSessionId}
        token={token}
        onAuthExpired={clearToken}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Browser Viewer Control Panel
          </h1>
          <p className="text-sm text-muted-foreground">
            React + Vite + shadcn/ui + Tailwind + Theme Toggle
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={clearToken}>
            Logout
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <section className="rounded-xl border border-border/80 bg-card/70 p-5 backdrop-blur">
        <label className="mb-2 block text-sm font-medium" htmlFor="target-url">
          Target URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="target-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="h-10 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
            placeholder="https://example.com"
          />
          <Button onClick={createSession} disabled={loading}>
            {loading ? "Creating..." : "Create Session"}
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border/80 bg-card/70 p-5 backdrop-blur">
        {error && <p className="text-sm text-red-500">{error}</p>}
        {!error && sessions.length === 0 && !loadingSessions && (
          <p className="text-sm text-muted-foreground">
            No active session yet.
          </p>
        )}
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium">Existing Sessions</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void loadSessions();
            }}
            disabled={loadingSessions}
          >
            {loadingSessions ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
        {sessions.length > 0 && (
          <div className="space-y-2">
            {sessions.map((session) => (
              <div
                key={session.sessionId}
                className="flex flex-col gap-2 rounded-md border border-border/70 bg-background/50 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">{session.sessionId}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {session.targetUrl}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Status: {session.connected ? "Connected" : "Disconnected"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last activity: {formatDateTime(session.lastActivityAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      enterSession(session.sessionId);
                    }}
                  >
                    Enter
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-red-600"
                    disabled={deletingSessionId === session.sessionId}
                    onClick={() => {
                      void removeSession(session.sessionId);
                    }}
                  >
                    {deletingSessionId === session.sessionId
                      ? "Deleting..."
                      : "Delete"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
