import type { SessionSearchContext, SessionSearchQuery, SessionSearchResponse, SessionSearchStatus } from "@runweave/shared/session-search";
import { requestJson } from "./http";

export function sessionSearchClient(apiBase: string, token: string, signal?: AbortSignal) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    status: () => requestJson<SessionSearchStatus>(apiBase, "/api/session-search/status", { headers, signal }),
    refresh: () => requestJson<SessionSearchStatus>(apiBase, "/api/session-search/refresh", { method: "POST", headers, signal, body: "{}" }),
    search: (query: SessionSearchQuery) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return requestJson<SessionSearchResponse>(apiBase, `/api/session-search/search?${params}`, { headers, signal });
    },
    context: (id: string) => requestJson<SessionSearchContext>(apiBase, `/api/session-search/records/${encodeURIComponent(id)}`, { headers, signal }),
  };
}
