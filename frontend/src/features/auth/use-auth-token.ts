import { useCallback, useState } from "react";

interface UseAuthTokenResult {
  token: string | null;
  setToken: (nextToken: string) => void;
  clearToken: () => void;
}

export function useAuthToken(storageKey: string): UseAuthTokenResult {
  const [token, setTokenState] = useState<string | null>(() => {
    return localStorage.getItem(storageKey);
  });

  const setToken = useCallback(
    (nextToken: string): void => {
      localStorage.setItem(storageKey, nextToken);
      setTokenState(nextToken);
    },
    [storageKey],
  );

  const clearToken = useCallback((): void => {
    localStorage.removeItem(storageKey);
    setTokenState(null);
  }, [storageKey]);

  return { token, setToken, clearToken };
}
