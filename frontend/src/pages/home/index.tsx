import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SessionListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { HttpError } from "../../services/http";
import { changePassword as submitPasswordChange } from "../../services/auth";
import {
  createTerminalSession,
  listTerminalSessions,
} from "../../services/terminal";
import {
  createSession as createBrowserSession,
  deleteSession as deleteBrowserSession,
  getDefaultCdpEndpoint,
  listSessions as fetchBrowserSessionList,
  updateSession as updateBrowserSession,
} from "../../services/session";
import { HomeHeader } from "./components/home-header";
import { ChangePasswordDialog } from "./components/change-password-dialog";
import { HomeSidebar } from "./components/home-sidebar";
import { SessionList } from "./components/session-list";
import { parseSessionHeaders } from "./utils";

interface HomePageProps {
  apiBase: string;
  token: string;
  clearToken: () => void;
  connections?: Array<{
    id: string;
    name: string;
    url: string;
    createdAt: number;
    isSystem?: boolean;
    canEdit?: boolean;
    canDelete?: boolean;
  }>;
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
}

export function HomePage({
  apiBase,
  token,
  clearToken,
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
}: HomePageProps) {
  const navigate = useNavigate();
  const [sessionSourceType, setSessionSourceType] = useState<
    "launch" | "connect-cdp"
  >("connect-cdp");
  const [sessionName, setSessionName] = useState("CDP Playweight");
  const [sessionNameCustomized, setSessionNameCustomized] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [cdpEndpoint, setCdpEndpoint] = useState("http://127.0.0.1:9222");
  const [defaultCdpEndpoint, setDefaultCdpEndpoint] = useState(
    "http://127.0.0.1:9222",
  );
  const [cdpEndpointCustomized, setCdpEndpointCustomized] = useState(false);
  const [requestHeadersInput, setRequestHeadersInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(
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

  const resolveReusableTerminalSession = (
    terminalSessions: TerminalSessionListItem[],
  ): TerminalSessionListItem | null => {
    const runningSessions = terminalSessions
      .filter((session) => session.status === "running")
      .sort((left, right) => {
        return (
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
        );
      });

    return runningSessions[0] ?? null;
  };

  const loadSessions = useCallback(async (): Promise<void> => {
    setLoadingSessions(true);
    try {
      const items = await fetchBrowserSessionList(apiBase, token);
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
    let cancelled = false;

    const loadDefaultCdpEndpoint = async (): Promise<void> => {
      try {
        const data = await getDefaultCdpEndpoint(apiBase, token);
        if (cancelled || !data.endpoint) {
          return;
        }
        setDefaultCdpEndpoint(data.endpoint);
        if (!cdpEndpointCustomized) {
          setCdpEndpoint(data.endpoint);
        }
      } catch {
        // Ignore default endpoint failures.
      }
    };

    void loadDefaultCdpEndpoint();

    return () => {
      cancelled = true;
    };
  }, [apiBase, token, cdpEndpointCustomized]);

  const enterSession = (sessionId: string): void => {
    navigate(`/viewer/${encodeURIComponent(sessionId)}`);
  };

  const getDefaultSessionName = (
    sourceType: "launch" | "connect-cdp",
  ): string => {
    return sourceType === "connect-cdp"
      ? "CDP Playweight"
      : "Default Playweight";
  };

  const changeSessionSourceType = (value: "launch" | "connect-cdp"): void => {
    setSessionSourceType(value);
    if (!sessionNameCustomized || !sessionName.trim()) {
      setSessionName(getDefaultSessionName(value));
      setSessionNameCustomized(false);
    }
  };

  const removeSession = async (sessionId: string): Promise<void> => {
    setDeletingSessionId(sessionId);
    setError(null);
    try {
      await deleteBrowserSession(apiBase, token, sessionId);
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

  const renameSession = async (sessionId: string): Promise<void> => {
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      return;
    }

    const nextName = window.prompt("Session name", session.name);
    if (nextName === null) {
      return;
    }

    const trimmedName = nextName.trim();
    if (!trimmedName) {
      setError("Session name is required.");
      return;
    }

    setError(null);
    try {
      await updateBrowserSession(apiBase, token, sessionId, {
        name: trimmedName,
      });
      await loadSessions();
    } catch (renameError) {
      if (renameError instanceof HttpError && renameError.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }

      setError(String(renameError));
    }
  };

  const createSession = async (): Promise<void> => {
    if (loading) {
      return;
    }

    const trimmedName = sessionName.trim();
    if (!trimmedName) {
      setError("Session name is required.");
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
      const data = await createBrowserSession(
        apiBase,
        sessionSourceType === "connect-cdp"
          ? {
              name: trimmedName,
              source: {
                type: "connect-cdp",
                endpoint: trimmedCdpEndpoint,
              },
            }
          : {
              name: trimmedName,
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

  const createTerminal = async (): Promise<void> => {
    if (terminalLoading) {
      return;
    }

    setTerminalLoading(true);
    setTerminalError(null);

    try {
      const existingTerminalSessions = await listTerminalSessions(apiBase, token);
      const reusableSession = resolveReusableTerminalSession(existingTerminalSessions);
      if (reusableSession) {
        navigate(`/terminal/${encodeURIComponent(reusableSession.terminalSessionId)}`);
        return;
      }

      const data = await createTerminalSession(apiBase, token, {});
      navigate(`/terminal/${encodeURIComponent(data.terminalSessionId)}`);
    } catch (createError) {
      if (createError instanceof HttpError && createError.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }

      setTerminalError(String(createError));
    } finally {
      setTerminalLoading(false);
    }
  };

  const changePassword = async (payload: {
    oldPassword: string;
    newPassword: string;
  }): Promise<void> => {
    setPasswordChangeLoading(true);
    setPasswordChangeError(null);

    try {
      await submitPasswordChange(apiBase, token, payload);
      setPasswordDialogOpen(false);
      clearToken();
      navigate("/login", { replace: true });
    } catch (changeError) {
      if (changeError instanceof HttpError && changeError.status === 403) {
        setPasswordChangeError("Incorrect current password.");
        return;
      }
      if (changeError instanceof HttpError && changeError.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }

      setPasswordChangeError(String(changeError));
    } finally {
      setPasswordChangeLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-8 sm:py-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(217,226,211,0.75),transparent_32%),radial-gradient(circle_at_80%_20%,rgba(68,136,146,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,166,122,0.18),transparent_28%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col gap-8">
        <HomeHeader
          terminalLoading={terminalLoading}
          connections={connections}
          activeConnectionId={activeConnectionId}
          connectionName={connectionName}
          onSelectConnection={onSelectConnection}
          onOpenConnectionManager={onOpenConnectionManager}
          onOpenTerminal={() => {
            void createTerminal();
          }}
          onOpenChangePassword={() => {
            setPasswordChangeError(null);
            setPasswordDialogOpen(true);
          }}
          onLogout={() => {
            clearToken();
            navigate("/login", { replace: true });
          }}
        />
        <ChangePasswordDialog
          open={passwordDialogOpen}
          loading={passwordChangeLoading}
          error={passwordChangeError}
          onClose={() => {
            if (passwordChangeLoading) {
              return;
            }
            setPasswordChangeError(null);
            setPasswordDialogOpen(false);
          }}
          onSubmit={changePassword}
        />

        {terminalError ? (
          <p className="text-sm text-red-500" role="alert">
            {terminalError}
          </p>
        ) : null}

        <section className="grid flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <HomeSidebar
            sessionSourceType={sessionSourceType}
            onSessionSourceTypeChange={changeSessionSourceType}
            sessionName={sessionName}
            onSessionNameChange={(value) => {
              setSessionName(value);
              setSessionNameCustomized(
                value.trim() !== "" &&
                  value.trim() !== getDefaultSessionName(sessionSourceType),
              );
            }}
            cdpEndpoint={cdpEndpoint}
            cdpEndpointPlaceholder={defaultCdpEndpoint}
            onCdpEndpointChange={(value) => {
              setCdpEndpointCustomized(true);
              setCdpEndpoint(value);
            }}
            proxyEnabled={proxyEnabled}
            onProxyEnabledChange={setProxyEnabled}
            requestHeadersInput={requestHeadersInput}
            onRequestHeadersInputChange={setRequestHeadersInput}
            loading={loading}
            onSubmitSession={() => {
              void createSession();
            }}
            error={error}
          />

          <section className="flex min-h-[200px] flex-col rounded-[2rem] border border-border/60 bg-card/75 p-6 shadow-[0_30px_120px_-70px_rgba(17,24,39,0.65)] backdrop-blur-xl sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
                  Sessions
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {loadingSessions ? "Refreshing quietly..." : `${sortedSessions.length} total`}
                </p>
              </div>
            </div>

            <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              <SessionList
                sessions={sortedSessions}
                loadingSessions={loadingSessions}
                deletingSessionId={deletingSessionId}
                onRenameSession={(sessionId) => {
                  void renameSession(sessionId);
                }}
                onRemoveSession={(sessionId) => {
                  void removeSession(sessionId);
                }}
                onResumeSession={enterSession}
              />
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
