import { useEffect, useRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const QUERY_STALE_TIME_MS = 15_000;
const QUERY_GC_TIME_MS = 30 * 60_000;

export function buildAppConnectionQueryScope(input: {
  connectionId: string | null;
  apiBase: string;
}): string {
  const apiBase = input.apiBase.trim().replace(/\/+$/, "") || "same-origin";
  return `${input.connectionId ?? "no-connection"}::${apiBase}`;
}

export const appQueryKeys = {
  all: (scope: string) => ["connection", scope, "app"] as const,
  overview: (scope: string) =>
    [...appQueryKeys.all(scope), "home-overview"] as const,
  terminalPreview: (scope: string, projectId: string) =>
    [...appQueryKeys.all(scope), "terminal-preview", projectId] as const,
  terminalChanges: (scope: string, projectId: string) =>
    [...appQueryKeys.terminalPreview(scope, projectId), "changes"] as const,
  terminalDiff: (
    scope: string,
    projectId: string,
    path: string,
    kind: string,
  ) =>
    [
      ...appQueryKeys.terminalPreview(scope, projectId),
      "diff",
      kind,
      path,
    ] as const,
  terminalAsset: (scope: string, projectId: string, path: string) =>
    [...appQueryKeys.terminalPreview(scope, projectId), "asset", path] as const,
  terminalFile: (scope: string, projectId: string, path: string) =>
    [...appQueryKeys.terminalPreview(scope, projectId), "file", path] as const,
  terminalDirectory: (scope: string, projectId: string, path: string) =>
    [
      ...appQueryKeys.terminalPreview(scope, projectId),
      "directory",
      path,
    ] as const,
  terminalFileSearch: (scope: string, projectId: string, query: string) =>
    [
      ...appQueryKeys.terminalPreview(scope, projectId),
      "file-search",
      query,
    ] as const,
};

export function AppQueryProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<QueryClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: QUERY_GC_TIME_MS,
          retry: false,
          staleTime: QUERY_STALE_TIME_MS,
        },
        mutations: { retry: false },
      },
    });
  }

  useEffect(() => {
    const client = clientRef.current;
    return () => {
      client?.clear();
    };
  }, []);

  return (
    <QueryClientProvider client={clientRef.current}>
      {children}
    </QueryClientProvider>
  );
}
