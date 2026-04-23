import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpError } from "../../services/http";
import { refreshSession, verifyAuthToken } from "../../services/auth";
import {
  cleanupLegacyAuthStorage,
  clearConnectionAuth,
  getConnectionAuth,
  setConnectionAuth,
} from "./storage";

interface UseScopedAuthParams {
  apiBase: string;
  isElectron: boolean;
  connectionId: string | null;
  webStorageKey: string;
}

type AuthStatus = "checking" | "authenticated" | "unauthenticated";
const ACCESS_TOKEN_REFRESH_LEAD_MS = 60 * 1000;

interface AuthSessionState {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken?: string;
  sessionId: string;
}

function loadWebSession(storageKey: string): AuthSessionState | null {
  cleanupLegacyAuthStorage();
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  if (!raw.trim().startsWith("{")) {
    return {
      accessToken: raw,
      accessExpiresAt: Date.now() + 15 * 60 * 1000,
      sessionId: "legacy-session",
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AuthSessionState>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.accessExpiresAt !== "number" ||
      typeof parsed.sessionId !== "string"
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      accessExpiresAt: parsed.accessExpiresAt,
      refreshToken:
        typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      sessionId: parsed.sessionId,
    };
  } catch {
    return null;
  }
}

function saveWebSession(storageKey: string, session: AuthSessionState): void {
  localStorage.setItem(storageKey, JSON.stringify(session));
}

function toSessionState(session: {
  accessToken: string;
  expiresIn: number;
  sessionId: string;
  refreshToken?: string;
}): AuthSessionState {
  return {
    accessToken: session.accessToken,
    accessExpiresAt: Date.now() + session.expiresIn * 1000,
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
  };
}

function isSessionFresh(session: AuthSessionState | null): boolean {
  return Boolean(session && session.accessExpiresAt > Date.now());
}

function resolveStoredSessionStatus(
  apiBase: string,
  isElectron: boolean,
  session: AuthSessionState | null,
): AuthStatus {
  if (!apiBase || !session) {
    return "unauthenticated";
  }

  if (isSessionFresh(session)) {
    return "authenticated";
  }

  if (isElectron && !session.refreshToken) {
    return "unauthenticated";
  }

  return "checking";
}

function loadElectronSession(
  connectionId: string | null,
): AuthSessionState | null {
  const record = getConnectionAuth(connectionId);
  if (
    !(record?.accessToken ?? record?.token) ||
    typeof (record.accessExpiresAt ?? Date.now() + 15 * 60 * 1000) !== "number" ||
    !(record.sessionId ?? "legacy-session")
  ) {
    return null;
  }

  return {
    accessToken: record.accessToken ?? record.token ?? "",
    accessExpiresAt:
      record.accessExpiresAt ?? Date.now() + 15 * 60 * 1000,
    refreshToken: record.refreshToken,
    sessionId: record.sessionId ?? "legacy-session",
  };
}

export function useScopedAuth({
  apiBase,
  isElectron,
  connectionId,
  webStorageKey,
}: UseScopedAuthParams): {
  token: string | null;
  status: AuthStatus;
  setSession: (session: {
    accessToken: string;
    expiresIn: number;
    sessionId: string;
    refreshToken?: string;
  }) => void;
  clearSession: () => void;
  setToken: (nextToken: string) => void;
  clearToken: () => void;
} {
  cleanupLegacyAuthStorage();
  const authScopeKey = isElectron
    ? `electron:${connectionId ?? ""}`
    : `web:${webStorageKey}`;

  const initialSession = useMemo(() => {
    return isElectron
      ? loadElectronSession(connectionId)
      : loadWebSession(webStorageKey);
  }, [connectionId, isElectron, webStorageKey]);

  const [session, setSessionState] = useState<AuthSessionState | null>(
    initialSession,
  );
  const [sessionScopeKey, setSessionScopeKey] = useState(authScopeKey);
  const [status, setStatus] = useState<AuthStatus>(() => {
    return resolveStoredSessionStatus(apiBase, isElectron, initialSession);
  });
  const [validationNonce, setValidationNonce] = useState(0);
  const statusRef = useRef<AuthStatus>(status);

  const sessionMatchesScope = sessionScopeKey === authScopeKey;
  const effectiveSession = sessionMatchesScope ? session : initialSession;
  const effectiveStatus = sessionMatchesScope
    ? status
    : resolveStoredSessionStatus(apiBase, isElectron, initialSession);

  useEffect(() => {
    statusRef.current = effectiveStatus;
  }, [effectiveStatus]);

  const loadStoredSession = useCallback((): AuthSessionState | null => {
    return isElectron
      ? loadElectronSession(connectionId)
      : loadWebSession(webStorageKey);
  }, [connectionId, isElectron, webStorageKey]);

  const clearSession = useCallback(() => {
    if (isElectron) {
      if (connectionId) {
        clearConnectionAuth(connectionId);
      }
    } else {
      localStorage.removeItem(webStorageKey);
    }

    setSessionState(null);
    setSessionScopeKey(authScopeKey);
    setStatus("unauthenticated");
    statusRef.current = "unauthenticated";
    setValidationNonce((value) => value + 1);
  }, [authScopeKey, connectionId, isElectron, webStorageKey]);

  const setSession = useCallback(
    (nextSession: {
      accessToken: string;
      expiresIn: number;
      sessionId: string;
      refreshToken?: string;
    }) => {
      const storedSession = toSessionState(nextSession);
      if (isElectron) {
        if (connectionId) {
          setConnectionAuth(connectionId, storedSession);
        }
      } else {
        saveWebSession(webStorageKey, storedSession);
      }

      setSessionState(storedSession);
      setSessionScopeKey(authScopeKey);
      setStatus("authenticated");
      statusRef.current = "authenticated";
      setValidationNonce((value) => value + 1);
    },
    [authScopeKey, connectionId, isElectron, webStorageKey],
  );

  const setToken = useCallback(
    (nextToken: string) => {
      setSession({
        accessToken: nextToken,
        expiresIn: 15 * 60,
        sessionId: effectiveSession?.sessionId ?? "legacy-session",
        refreshToken: effectiveSession?.refreshToken,
      });
    },
    [effectiveSession?.refreshToken, effectiveSession?.sessionId, setSession],
  );

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      const nextSession = loadStoredSession();

      if (cancelled) {
        return;
      }

      setSessionState(nextSession);
      setSessionScopeKey(authScopeKey);
      if (!apiBase || !nextSession) {
        setStatus("unauthenticated");
        return;
      }

      if (isSessionFresh(nextSession)) {
        setSessionState(nextSession);
        setStatus("authenticated");

        if (isElectron) {
          void verifyAuthToken(apiBase, nextSession.accessToken).catch(
            (error: unknown) => {
              if (cancelled) {
                return;
              }

              if (error instanceof HttpError && error.status === 401) {
                if (connectionId) {
                  clearConnectionAuth(connectionId);
                }
                setSessionState(null);
                setSessionScopeKey(authScopeKey);
                setStatus("unauthenticated");
              }
            },
          );
        }

        return;
      }

      if (isElectron && !nextSession.refreshToken) {
        setStatus("unauthenticated");
        return;
      }

      setStatus("checking");

      try {
        const refreshed = await refreshSession(
          apiBase,
          isElectron
            ? {
                clientType: "electron",
                refreshToken: nextSession.refreshToken ?? "",
              }
            : { clientType: "web" },
        );
        if (cancelled) {
          return;
        }

        const storedSession = toSessionState(refreshed);
        if (isElectron) {
          if (connectionId) {
            setConnectionAuth(connectionId, storedSession);
          }
        } else {
          saveWebSession(webStorageKey, storedSession);
        }
        setSessionState(storedSession);
        setSessionScopeKey(authScopeKey);
        setStatus("authenticated");
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof HttpError && error.status === 401) {
          if (isElectron && connectionId) {
            clearConnectionAuth(connectionId);
          }
          if (!isElectron) {
            localStorage.removeItem(webStorageKey);
          }
        }

        if (isElectron && !(error instanceof HttpError && error.status === 401)) {
          setSessionState(nextSession);
          setSessionScopeKey(authScopeKey);
          setStatus("authenticated");
          return;
        }

        setSessionState(null);
        setSessionScopeKey(authScopeKey);
        setStatus("unauthenticated");
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    apiBase,
    authScopeKey,
    connectionId,
    isElectron,
    loadStoredSession,
    validationNonce,
    webStorageKey,
  ]);

  useEffect(() => {
    const revalidateExpiredSessionOnForeground = (): void => {
      if (!apiBase || document.visibilityState === "hidden") {
        return;
      }

      if (statusRef.current === "checking") {
        return;
      }

      const nextSession = loadStoredSession();
      if (!nextSession || isSessionFresh(nextSession)) {
        return;
      }

      statusRef.current = "checking";
      setStatus("checking");
      setValidationNonce((value) => value + 1);
    };

    document.addEventListener(
      "visibilitychange",
      revalidateExpiredSessionOnForeground,
    );
    window.addEventListener("focus", revalidateExpiredSessionOnForeground);

    return () => {
      document.removeEventListener(
        "visibilitychange",
        revalidateExpiredSessionOnForeground,
      );
      window.removeEventListener("focus", revalidateExpiredSessionOnForeground);
    };
  }, [apiBase, loadStoredSession]);

  useEffect(() => {
    if (!apiBase || !effectiveSession || effectiveStatus !== "authenticated") {
      return;
    }

    if (isElectron && !effectiveSession.refreshToken) {
      return;
    }

    let cancelled = false;
    const refreshDelayMs = Math.max(
      effectiveSession.accessExpiresAt - Date.now() - ACCESS_TOKEN_REFRESH_LEAD_MS,
      0,
    );
    const timer = window.setTimeout(() => {
      void refreshSession(
        apiBase,
        isElectron
          ? {
              clientType: "electron",
              refreshToken: effectiveSession.refreshToken ?? "",
            }
          : { clientType: "web" },
      )
        .then((refreshed) => {
          if (cancelled) {
            return;
          }

          const storedSession = toSessionState(refreshed);
          if (isElectron) {
            if (connectionId) {
              setConnectionAuth(connectionId, storedSession);
            }
          } else {
            saveWebSession(webStorageKey, storedSession);
          }
          setSessionState(storedSession);
          setSessionScopeKey(authScopeKey);
          setStatus("authenticated");
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }

          if (error instanceof HttpError && error.status === 401) {
            if (isElectron && connectionId) {
              clearConnectionAuth(connectionId);
            }
            if (!isElectron) {
              localStorage.removeItem(webStorageKey);
            }
          }

          if (isElectron && !(error instanceof HttpError && error.status === 401)) {
            return;
          }

          setSessionState(null);
          setSessionScopeKey(authScopeKey);
          setStatus("unauthenticated");
        });
    }, refreshDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    apiBase,
    authScopeKey,
    connectionId,
    effectiveSession,
    effectiveStatus,
    isElectron,
    webStorageKey,
  ]);

  return {
    token: effectiveSession?.accessToken ?? null,
    status: effectiveStatus,
    setSession,
    clearSession,
    setToken,
    clearToken: clearSession,
  };
}
