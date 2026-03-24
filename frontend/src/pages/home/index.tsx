import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SessionListItem } from "@browser-viewer/shared";
import { HttpError } from "../../services/http";
import {
  createSession as createViewerSession,
  deleteSession as deleteViewerSession,
  listSessions as fetchSessionList,
} from "../../services/session";
import { HomeHeader } from "./components/home-header";
import { LatestSessionCard } from "./components/latest-session-card";
import { NewSessionForm } from "./components/new-session-form";
import { SessionDrawer } from "./components/session-drawer";
import { parseSessionHeaders } from "./utils";

interface HomePageProps {
  apiBase: string;
  token: string;
  clearToken: () => void;
}

export function HomePage({ apiBase, token, clearToken }: HomePageProps) {
  const navigate = useNavigate();
  const [url, setUrl] = useState("https://www.google.cn");
  const [sessionSourceType, setSessionSourceType] = useState<
    "launch" | "connect-cdp"
  >("connect-cdp");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [cdpEndpoint, setCdpEndpoint] = useState("http://127.0.0.1:9222");
  const [requestHeadersInput, setRequestHeadersInput] = useState("");
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

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((left, right) => {
      return (
        new Date(right.lastActivityAt).getTime() -
        new Date(left.lastActivityAt).getTime()
      );
    });
  }, [sessions]);

  const recentSession = sortedSessions[0] ?? null;

  const loadSessions = useCallback(async (): Promise<void> => {
    setLoadingSessions(true);
    try {
      const items = await fetchSessionList(apiBase, token);
      setSessions(items);
    } catch (listError) {
      if (listError instanceof HttpError && listError.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }

      setError(String(listError));
    } finally {
      setLoadingSessions(false);
    }
  }, [apiBase, clearToken, navigate, token]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

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
    navigate(`/viewer/${encodeURIComponent(sessionId)}`);
  };

  const removeSession = async (sessionId: string): Promise<void> => {
    setDeletingSessionId(sessionId);
    setError(null);
    try {
      await deleteViewerSession(apiBase, token, sessionId);
      await loadSessions();
    } catch (deleteError) {
      if (deleteError instanceof HttpError && deleteError.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
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

    const trimmedCdpEndpoint = cdpEndpoint.trim();
    if (sessionSourceType === "connect-cdp" && !trimmedCdpEndpoint) {
      setError("CDP endpoint is required when attaching to an existing browser.");
      return;
    }

    let parsedHeaders: Record<string, string>;
    if (sessionSourceType === "launch") {
      try {
        parsedHeaders = parseSessionHeaders(requestHeadersInput);
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : String(parseError));
        return;
      }
    } else {
      parsedHeaders = {};
    }

    setLoading(true);
    setError(null);

    try {
      const data = await createViewerSession(
        apiBase,
        sessionSourceType === "connect-cdp"
          ? {
              url,
              source: {
                type: "connect-cdp",
                endpoint: trimmedCdpEndpoint,
              },
            }
          : {
              url,
              source: {
                type: "launch",
                proxyEnabled,
                headers:
                  Object.keys(parsedHeaders).length > 0
                    ? parsedHeaders
                    : undefined,
              },
            },
        token,
      );
      await loadSessions();
      setIsSessionDrawerOpen(false);
      enterSession(data.sessionId);
    } catch (createError) {
      if (createError instanceof HttpError && createError.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }

      setError(String(createError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-8 sm:py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.75),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(68,136,146,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,166,122,0.18),transparent_28%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl flex-col gap-8">
        <HomeHeader
          sessionCount={sessions.length}
          onOpenSessions={() => setIsSessionDrawerOpen(true)}
          onLogout={() => {
            clearToken();
            navigate("/login", { replace: true });
          }}
        />

        <section className="flex flex-1 items-center pb-4 pt-2 sm:pt-4">
          <div className="w-full">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
              <LatestSessionCard session={recentSession} onEnterSession={enterSession} />

              <NewSessionForm
                sessionSourceType={sessionSourceType}
                onSessionSourceTypeChange={setSessionSourceType}
                cdpEndpoint={cdpEndpoint}
                onCdpEndpointChange={setCdpEndpoint}
                url={url}
                onUrlChange={setUrl}
                proxyEnabled={proxyEnabled}
                onProxyEnabledChange={setProxyEnabled}
                requestHeadersInput={requestHeadersInput}
                onRequestHeadersInputChange={setRequestHeadersInput}
                loading={loading}
                onSubmit={() => {
                  void createSession();
                }}
                error={error}
              />
            </div>
          </div>
        </section>
      </div>

      <SessionDrawer
        isOpen={isSessionDrawerOpen}
        loadingSessions={loadingSessions}
        sessions={sortedSessions}
        deletingSessionId={deletingSessionId}
        activeSessionMenuId={activeSessionMenuId}
        onClose={() => setIsSessionDrawerOpen(false)}
        onToggleMenu={(sessionId) => {
          setActiveSessionMenuId((currentId) => {
            return currentId === sessionId ? null : sessionId;
          });
        }}
        onRemoveSession={(sessionId) => {
          setActiveSessionMenuId(null);
          void removeSession(sessionId);
        }}
        onResumeSession={(sessionId) => {
          setIsSessionDrawerOpen(false);
          enterSession(sessionId);
        }}
      />
    </main>
  );
}
