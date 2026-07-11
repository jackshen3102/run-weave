import { useEffect, useRef, type ReactNode } from "react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

const QUERY_STALE_TIME_MS = 15_000;
const QUERY_GC_TIME_MS = 30 * 60_000;

export function buildConnectionQueryScope(input: {
  apiBase: string;
  connectionId: string | null;
}): string {
  const apiBase = input.apiBase.trim().replace(/\/+$/, "") || "same-origin";
  return `${input.connectionId ?? "web"}::${apiBase}`;
}

export function ConnectionQueryProvider({
  children,
  onUnauthorized,
  scope,
}: {
  children: ReactNode;
  onUnauthorized?: () => void;
  scope: string;
}) {
  const clientsRef = useRef(new Map<string, QueryClient>());
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  let client = clientsRef.current.get(scope);
  if (!client) {
    const handleError = (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 401
      ) {
        onUnauthorizedRef.current?.();
      }
    };
    client = new QueryClient({
      mutationCache: new MutationCache({ onError: handleError }),
      queryCache: new QueryCache({ onError: handleError }),
      defaultOptions: {
        queries: {
          gcTime: QUERY_GC_TIME_MS,
          retry: false,
          staleTime: QUERY_STALE_TIME_MS,
        },
        mutations: {
          retry: false,
        },
      },
    });
    clientsRef.current.set(scope, client);
  }

  useEffect(() => {
    const clients = clientsRef.current;
    return () => {
      for (const scopedClient of clients.values()) {
        scopedClient.clear();
      }
      clients.clear();
    };
  }, []);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
