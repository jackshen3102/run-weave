import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionListItem } from "@browser-viewer/shared";
import { HttpError } from "../../../services/http";
import {
  createSession as createBrowserSession,
  deleteSession as deleteBrowserSession,
  ensureAiDefaultSession as ensureBrowserAiDefaultSession,
  getDefaultCdpEndpoint,
  listSessions as fetchBrowserSessionList,
  updateSessionAiPreference as updateBrowserSessionAiPreference,
  updateSession as updateBrowserSession,
} from "../../../services/session";
import { parseSessionHeaders } from "../utils";

type SessionSourceType = "launch" | "connect-cdp";

interface UseHomeSessionsParams {
  apiBase: string;
  token: string;
  onAuthExpired: () => void;
  onEnterSession: (sessionId: string) => void;
}

function getDefaultSessionName(sourceType: SessionSourceType): string {
  return sourceType === "connect-cdp" ? "CDP Playweight" : "Default Playweight";
}

export function useHomeSessions({
  apiBase,
  token,
  onAuthExpired,
  onEnterSession,
}: UseHomeSessionsParams) {
  const [sessionSourceType, setSessionSourceType] =
    useState<SessionSourceType>("connect-cdp");
  const [sessionName, setSessionNameState] = useState("CDP Playweight");
  const [sessionNameCustomized, setSessionNameCustomized] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [cdpEndpoint, setCdpEndpointState] = useState("http://127.0.0.1:9222");
  const [defaultCdpEndpoint, setDefaultCdpEndpoint] = useState(
    "http://127.0.0.1:9222",
  );
  const [cdpEndpointCustomized, setCdpEndpointCustomized] = useState(false);
  const [requestHeadersInput, setRequestHeadersInput] = useState("");
  const [preferredForAi, setPreferredForAi] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [openingAiViewer, setOpeningAiViewer] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [updatingAiPreferenceSessionId, setUpdatingAiPreferenceSessionId] =
    useState<string | null>(null);

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((left, right) => {
      if (left.preferredForAi !== right.preferredForAi) {
        return left.preferredForAi ? -1 : 1;
      }
      return (
        new Date(right.lastActivityAt).getTime() -
        new Date(left.lastActivityAt).getTime()
      );
    });
  }, [sessions]);

  const loadSessions = useCallback(async (): Promise<void> => {
    setLoadingSessions(true);
    try {
      const items = await fetchBrowserSessionList(apiBase, token);
      setSessions(items);
    } catch (listError) {
      if (listError instanceof HttpError && listError.status === 401) {
        onAuthExpired();
        return;
      }

      setError(String(listError));
    } finally {
      setLoadingSessions(false);
    }
  }, [apiBase, onAuthExpired, token]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;

    const loadDefaultEndpoint = async (): Promise<void> => {
      try {
        const data = await getDefaultCdpEndpoint(apiBase, token);
        if (cancelled || !data.endpoint) {
          return;
        }

        setDefaultCdpEndpoint(data.endpoint);
        if (!cdpEndpointCustomized) {
          setCdpEndpointState(data.endpoint);
        }
      } catch {
        // Ignore default endpoint failures.
      }
    };

    void loadDefaultEndpoint();

    return () => {
      cancelled = true;
    };
  }, [apiBase, cdpEndpointCustomized, token]);

  const setSessionSource = useCallback((value: SessionSourceType): void => {
    setSessionSourceType(value);
    if (value !== "launch") {
      setPreferredForAi(false);
    }
    setSessionNameState((currentName) => {
      if (!sessionNameCustomized || !currentName.trim()) {
        setSessionNameCustomized(false);
        return getDefaultSessionName(value);
      }

      return currentName;
    });
  }, [sessionNameCustomized]);

  const setSessionName = useCallback(
    (value: string): void => {
      setSessionNameState(value);
      setSessionNameCustomized(
        value.trim() !== "" && value.trim() !== getDefaultSessionName(sessionSourceType),
      );
    },
    [sessionSourceType],
  );

  const setCdpEndpoint = useCallback((value: string): void => {
    setCdpEndpointCustomized(true);
    setCdpEndpointState(value);
  }, []);

  const createSession = useCallback(async (): Promise<void> => {
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
              preferredForAi,
              source: {
                type: "connect-cdp",
                endpoint: trimmedCdpEndpoint,
              },
            }
          : {
              name: trimmedName,
              preferredForAi,
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
      onEnterSession(data.sessionId);
    } catch (createError) {
      if (createError instanceof HttpError && createError.status === 401) {
        onAuthExpired();
        return;
      }

      setError(String(createError));
    } finally {
      setLoading(false);
    }
  }, [
    apiBase,
    cdpEndpoint,
    loadSessions,
    loading,
    onAuthExpired,
    onEnterSession,
    proxyEnabled,
    requestHeadersInput,
    sessionName,
    sessionSourceType,
    token,
    preferredForAi,
  ]);

  const removeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      setDeletingSessionId(sessionId);
      setError(null);
      try {
        await deleteBrowserSession(apiBase, token, sessionId);
        await loadSessions();
      } catch (deleteError) {
        if (deleteError instanceof HttpError && deleteError.status === 401) {
          onAuthExpired();
          return;
        }

        setError(String(deleteError));
      } finally {
        setDeletingSessionId(null);
      }
    },
    [apiBase, loadSessions, onAuthExpired, token],
  );

  const openAiViewer = useCallback(async (): Promise<void> => {
    if (openingAiViewer) {
      return;
    }

    setOpeningAiViewer(true);
    setError(null);
    try {
      const session = await ensureBrowserAiDefaultSession(apiBase, token);
      await loadSessions();
      onEnterSession(session.sessionId);
    } catch (openError) {
      if (openError instanceof HttpError && openError.status === 401) {
        onAuthExpired();
        return;
      }

      setError(String(openError));
    } finally {
      setOpeningAiViewer(false);
    }
  }, [apiBase, loadSessions, onAuthExpired, onEnterSession, openingAiViewer, token]);

  const renameSession = useCallback(
    async (sessionId: string): Promise<void> => {
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
          onAuthExpired();
          return;
        }

        setError(String(renameError));
      }
    },
    [apiBase, loadSessions, onAuthExpired, sessions, token],
  );

  const updateSessionAiPreference = useCallback(
    async (sessionId: string, nextPreferredForAi: boolean): Promise<void> => {
      setUpdatingAiPreferenceSessionId(sessionId);
      setError(null);
      try {
        await updateBrowserSessionAiPreference(
          apiBase,
          token,
          sessionId,
          nextPreferredForAi,
        );
        await loadSessions();
      } catch (updateError) {
        if (updateError instanceof HttpError && updateError.status === 401) {
          onAuthExpired();
          return;
        }

        setError(String(updateError));
      } finally {
        setUpdatingAiPreferenceSessionId(null);
      }
    },
    [apiBase, loadSessions, onAuthExpired, token],
  );

  return {
    sessionSourceType,
    setSessionSourceType: setSessionSource,
    sessionName,
    setSessionName,
    proxyEnabled,
    setProxyEnabled,
    cdpEndpoint,
    defaultCdpEndpoint,
    setCdpEndpoint,
    requestHeadersInput,
    setRequestHeadersInput,
    preferredForAi,
    setPreferredForAi,
    loading,
    error,
    sessions,
    sortedSessions,
    loadingSessions,
    openingAiViewer,
    deletingSessionId,
    updatingAiPreferenceSessionId,
    openAiViewer,
    createSession,
    removeSession,
    renameSession,
    updateSessionAiPreference,
  };
}
