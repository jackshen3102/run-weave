import { useCallback, useEffect, useMemo, useState } from "react";
import { HttpError } from "../../services/http";
import { verifyAuthToken } from "../../services/auth";
import {
  cleanupLegacyAuthStorage,
  clearConnectionToken,
  getConnectionAuth,
  setConnectionToken,
} from "./storage";

interface UseScopedAuthParams {
  apiBase: string;
  isElectron: boolean;
  connectionId: string | null;
  webStorageKey: string;
}

type AuthStatus = "checking" | "authenticated" | "unauthenticated";

function loadWebToken(storageKey: string): string | null {
  cleanupLegacyAuthStorage();
  return localStorage.getItem(storageKey);
}

export function useScopedAuth({
  apiBase,
  isElectron,
  connectionId,
  webStorageKey,
}: UseScopedAuthParams): {
  token: string | null;
  status: AuthStatus;
  setToken: (nextToken: string) => void;
  clearToken: () => void;
} {
  cleanupLegacyAuthStorage();

  const initialToken = useMemo(() => {
    if (!isElectron) {
      return loadWebToken(webStorageKey);
    }
    return getConnectionAuth(connectionId)?.token ?? null;
  }, [connectionId, isElectron, webStorageKey]);

  const [token, setTokenState] = useState<string | null>(initialToken);
  const [status, setStatus] = useState<AuthStatus>(() => {
    return initialToken ? (isElectron ? "checking" : "authenticated") : "unauthenticated";
  });

  const [validationNonce, setValidationNonce] = useState(0);

  const clearToken = useCallback(() => {
    if (isElectron) {
      if (connectionId) {
        clearConnectionToken(connectionId);
      }
    } else {
      localStorage.removeItem(webStorageKey);
    }

    setTokenState(null);
    setStatus("unauthenticated");
    setValidationNonce((value) => value + 1);
  }, [connectionId, isElectron, webStorageKey]);

  const setToken = useCallback(
    (nextToken: string): void => {
      if (isElectron) {
        if (connectionId) {
          setConnectionToken(connectionId, nextToken);
        }
      } else {
        localStorage.setItem(webStorageKey, nextToken);
      }

      setTokenState(nextToken);
      setStatus("authenticated");
      setValidationNonce((value) => value + 1);
    },
    [connectionId, isElectron, webStorageKey],
  );

  useEffect(() => {
    if (!isElectron) {
      const nextToken = loadWebToken(webStorageKey);
      setTokenState(nextToken);
      setStatus(nextToken ? "authenticated" : "unauthenticated");
      return;
    }

    const scopedToken = getConnectionAuth(connectionId)?.token ?? null;
    setTokenState(scopedToken);

    if (!connectionId || !apiBase || !scopedToken) {
      setStatus("unauthenticated");
      return;
    }

    let cancelled = false;
    setStatus("checking");

    void verifyAuthToken(apiBase, scopedToken)
      .then(() => {
        if (cancelled) {
          return;
        }
        setTokenState(scopedToken);
        setStatus("authenticated");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        if (error instanceof HttpError && error.status === 401) {
          clearConnectionToken(connectionId);
        }

        setTokenState(null);
        setStatus("unauthenticated");
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, connectionId, isElectron, validationNonce, webStorageKey]);

  return { token, status, setToken, clearToken };
}
