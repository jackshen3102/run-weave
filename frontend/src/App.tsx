import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "@browser-viewer/shared";
import { MoreHorizontal, RefreshCw } from "lucide-react";
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

function formatDateTime(isoTime: string): string {
  return new Date(isoTime).toLocaleString();
}

function getSessionDisplayTitle(targetUrl: string): string {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    return targetUrl;
  }
}

export default function App() {
  const [url, setUrl] = useState("https://www.google.cn");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [isSessionDrawerOpen, setIsSessionDrawerOpen] = useState(false);
  const [activeSessionMenuId, setActiveSessionMenuId] = useState<string | null>(
    null,
  );
  const urlInputRef = useRef<HTMLInputElement>(null);
  const { token, setToken, clearToken } = useAuthToken(AUTH_TOKEN_STORAGE_KEY);

  const searchParams = new URLSearchParams(window.location.search);
  const viewerSessionId = searchParams.get("sessionId");

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((left, right) => {
      return (
        new Date(right.lastActivityAt).getTime() -
        new Date(left.lastActivityAt).getTime()
      );
    });
  }, [sessions]);

  const recentSession = sortedSessions[0] ?? null;

  const setTokenAndPersist = (nextToken: string): void => {
    setToken(nextToken);
    setError(null);
  };

  const loadSessions = useCallback(async (): Promise<void> => {
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
  }, [clearToken, token]);

  useEffect(() => {
    if (viewerSessionId) {
      return;
    }

    void loadSessions();
  }, [loadSessions, viewerSessionId]);

  useEffect(() => {
    if (!isSessionDrawerOpen) {
      setActiveSessionMenuId(null);
      return;
    }

    void loadSessions();
  }, [isSessionDrawerOpen, loadSessions]);

  useEffect(() => {
    if (!activeSessionMenuId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest("[data-session-menu-root='true']")) {
        return;
      }

      setActiveSessionMenuId(null);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setActiveSessionMenuId(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeSessionMenuId]);

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

  const createSession = async (): Promise<void> => {
    if (loading) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (!token) {
        clearToken();
        return;
      }

      const data = await createViewerSession(
        API_BASE,
        { url, proxyEnabled },
        token,
      );
      await loadSessions();
      setIsSessionDrawerOpen(false);
      enterSession(data.sessionId);
    } catch (createError) {
      if (createError instanceof HttpError && createError.status === 401) {
        clearToken();
        return;
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
    <main className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-8 sm:py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.75),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(68,136,146,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,166,122,0.18),transparent_28%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl flex-col gap-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
              Browser Viewer
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full border border-border/60 bg-background/60 px-4 backdrop-blur"
              onClick={() => setIsSessionDrawerOpen(true)}
            >
              Sessions{sessions.length > 0 ? ` ${sessions.length}` : ""}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full px-4 text-muted-foreground"
              onClick={clearToken}
            >
              Logout
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <section className="flex flex-1 items-center pb-4 pt-2 sm:pt-4">
          <div className="w-full">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.38fr)_minmax(320px,0.62fr)]">
              <section
                className={`animate-fade-rise rounded-[2rem] border border-border/60 bg-card/75 p-6 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl transition hover:border-border/80 sm:p-8 ${
                  recentSession ? "cursor-pointer" : ""
                }`}
                role={recentSession ? "button" : undefined}
                tabIndex={recentSession ? 0 : undefined}
                onClick={
                  recentSession
                    ? () => enterSession(recentSession.sessionId)
                    : undefined
                }
                onKeyDown={
                  recentSession
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          enterSession(recentSession.sessionId);
                        }
                      }
                    : undefined
                }
              >
                {recentSession ? (
                  <>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground/70">
                        Latest Session
                      </p>
                      <span className="inline-flex items-center gap-2 rounded-full bg-background/70 px-3 py-1 text-xs text-muted-foreground">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            recentSession.connected
                              ? "bg-emerald-500"
                              : "bg-stone-400"
                          }`}
                        />
                        {recentSession.connected ? "Live" : "Idle"}
                      </span>
                    </div>

                    <div className="mt-12 space-y-4">
                      <p className="text-4xl font-semibold tracking-[-0.06em] text-foreground sm:text-[4.2rem] sm:leading-[0.96]">
                        {getSessionDisplayTitle(recentSession.targetUrl)}
                      </p>
                      <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
                        {recentSession.targetUrl}
                      </p>
                      <p className="text-sm text-muted-foreground/85">
                        Last active{" "}
                        {formatDateTime(recentSession.lastActivityAt)}
                      </p>
                      {recentSession.proxyEnabled && (
                        <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">
                          Proxy enabled
                        </p>
                      )}
                    </div>

                    <div className="mt-12 flex flex-wrap items-center gap-3">
                      <Button
                        className="h-11 rounded-full px-6 text-sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          enterSession(recentSession.sessionId);
                        }}
                      >
                        Resume
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-12 py-8 sm:py-14">
                    <div className="space-y-4">
                      <p className="text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground/70">
                        Start
                      </p>
                      <p className="max-w-xl text-4xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl">
                        Nothing open yet. Start with a page.
                      </p>
                    </div>
                    <p className="max-w-lg text-sm leading-6 text-muted-foreground sm:text-base">
                      Open one address and let the stage stay quiet around it.
                    </p>
                  </div>
                )}
              </section>

              <section className="animate-fade-rise flex flex-col justify-between rounded-[2rem] border border-border/60 bg-background/65 p-6 backdrop-blur-xl sm:p-7">
                <div className="space-y-3">
                  <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
                    New Session
                  </p>
                  <p className="text-2xl font-semibold tracking-[-0.04em] text-foreground">
                    Start somewhere else.
                  </p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Keep the input thin and the first action obvious.
                  </p>
                  {recentSession && (
                    <button
                      type="button"
                      className="text-sm font-medium tracking-[-0.01em] text-muted-foreground transition hover:text-foreground"
                      onClick={() => urlInputRef.current?.focus()}
                    >
                      Need a clean take? Start a fresh address.
                    </button>
                  )}
                </div>

                <div className="mt-10 space-y-4">
                  <label className="sr-only" htmlFor="target-url">
                    Target URL
                  </label>
                  <div className="rounded-[1.5rem] border border-border/60 bg-card/75 p-3 shadow-[0_18px_60px_-40px_rgba(17,24,39,0.6)]">
                    <input
                      id="target-url"
                      ref={urlInputRef}
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !loading) {
                          event.preventDefault();
                          void createSession();
                        }
                      }}
                      disabled={loading}
                      className="h-12 w-full border-0 bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground/55"
                      placeholder="https://example.com"
                    />
                  </div>

                  <Button
                    className="h-11 w-full rounded-full text-sm"
                    onClick={() => {
                      void createSession();
                    }}
                    disabled={loading}
                  >
                    {loading ? "Starting..." : "Start"}
                  </Button>

                  <label
                    htmlFor="session-proxy-enabled"
                    className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-border/60 bg-background/60 px-4 py-3 text-sm text-foreground"
                  >
                    <span className="space-y-1">
                      <span className="block font-medium">Enable proxy</span>
                      <span className="block text-xs text-muted-foreground">
                        Route this session through Whistle at 127.0.0.1:8899.
                      </span>
                    </span>
                    <input
                      id="session-proxy-enabled"
                      type="checkbox"
                      aria-label="Enable proxy"
                      checked={proxyEnabled}
                      onChange={(event) =>
                        setProxyEnabled(event.target.checked)
                      }
                      disabled={loading}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary/40"
                    />
                  </label>

                  {error && (
                    <p className="text-sm text-red-500" role="alert">
                      {error}
                    </p>
                  )}
                </div>
              </section>
            </div>
          </div>
        </section>
      </div>

      <div
        className={`fixed inset-0 z-40 bg-black/16 transition-opacity ${
          isSessionDrawerOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsSessionDrawerOpen(false)}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border/60 bg-background/94 px-5 py-6 shadow-2xl backdrop-blur-xl transition-transform duration-300 sm:px-6 ${
          isSessionDrawerOpen ? "translate-x-0" : "translate-x-full"
        } ${isSessionDrawerOpen ? "animate-panel-in" : ""}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
              Sessions
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground">
              Quiet history.
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-4"
            onClick={() => setIsSessionDrawerOpen(false)}
          >
            Close
          </Button>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {loadingSessions
              ? "Refreshing quietly..."
              : `${sessions.length} total`}
          </span>
          <span className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground/55">
            <RefreshCw
              className={`h-3.5 w-3.5 ${loadingSessions ? "animate-spin" : ""}`}
            />
            Synced
          </span>
        </div>

        <div className="mt-6 flex-1 space-y-3 overflow-y-auto pr-1">
          {sortedSessions.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-border/60 px-5 py-6 text-sm text-muted-foreground">
              No other sessions.
            </div>
          ) : (
            sortedSessions.map((session) => {
              const isDeleting = deletingSessionId === session.sessionId;
              const isMenuOpen = activeSessionMenuId === session.sessionId;

              return (
                <article
                  key={session.sessionId}
                  className="rounded-[1.5rem] border border-border/60 bg-card/72 p-4 transition-colors hover:border-border/80"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            session.connected
                              ? "bg-emerald-500"
                              : "bg-stone-400"
                          }`}
                        />
                        <p className="truncate text-base font-medium tracking-[-0.03em] text-foreground">
                          {getSessionDisplayTitle(session.targetUrl)}
                        </p>
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {session.targetUrl}
                      </p>
                      <p className="text-xs text-muted-foreground/85">
                        Last active {formatDateTime(session.lastActivityAt)}
                      </p>
                      {session.proxyEnabled && (
                        <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground/80">
                          Proxy enabled
                        </p>
                      )}
                    </div>
                    <div
                      className="relative flex items-center gap-2"
                      data-session-menu-root="true"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full px-3 text-muted-foreground"
                        aria-label="Session actions"
                        onClick={() => {
                          setActiveSessionMenuId((currentId) => {
                            return currentId === session.sessionId
                              ? null
                              : session.sessionId;
                          });
                        }}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                      {isMenuOpen && (
                        <div className="animate-scale-fade absolute right-0 top-11 z-10 min-w-40 rounded-2xl border border-border/70 bg-background/96 p-2 shadow-[0_20px_50px_-30px_rgba(17,24,39,0.55)] backdrop-blur-xl">
                          <button
                            type="button"
                            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-red-500 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                            disabled={isDeleting}
                            onClick={() => {
                              setActiveSessionMenuId(null);
                              void removeSession(session.sessionId);
                            }}
                          >
                            <span>
                              {isDeleting ? "Removing..." : "Remove session"}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-end gap-3">
                    <Button
                      size="sm"
                      className="rounded-full px-4"
                      onClick={() => {
                        setIsSessionDrawerOpen(false);
                        enterSession(session.sessionId);
                      }}
                    >
                      Resume
                    </Button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </aside>
    </main>
  );
}
