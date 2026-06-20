import { useMemoizedFn } from "ahooks";
import { useState } from "react";

interface UseAuthTokenResult {
  token: string | null;
  setToken: (nextToken: string) => void;
  clearToken: () => void;
}

export function useAuthToken(storageKey: string): UseAuthTokenResult {
  const [token, setTokenState] = useState<string | null>(() => {
    return localStorage.getItem(storageKey);
  });

  const setToken = useMemoizedFn((nextToken: string): void => {
    localStorage.setItem(storageKey, nextToken);
    setTokenState(nextToken);
  });

  const clearToken = useMemoizedFn((): void => {
    localStorage.removeItem(storageKey);
    setTokenState(null);
  });

  return { token, setToken, clearToken };
}
