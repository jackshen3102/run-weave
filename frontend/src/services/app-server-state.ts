import type { AppServerThreadListResponse, AppServerThreadResponse } from "@runweave/shared/app-server-events";
import { requestJson } from "./http";

interface ListAppServerThreadsFilters {
  projectId?: string | null;
  terminalSessionId?: string | null;
  terminalPanelId?: string | null;
  agent?: string | null;
  status?: string | null;
  after?: string | null;
  limit?: number;
}

function authHeaders(token: string): { Authorization: string } {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function listAppServerThreads(
  apiBase: string,
  token: string,
  filters: ListAppServerThreadsFilters,
): Promise<AppServerThreadListResponse> {
  const query = new URLSearchParams();
  if (filters.projectId) {
    query.set("projectId", filters.projectId);
  }
  if (filters.terminalSessionId) {
    query.set("terminalSessionId", filters.terminalSessionId);
  }
  if (filters.terminalPanelId) {
    query.set("terminalPanelId", filters.terminalPanelId);
  }
  if (filters.agent) {
    query.set("agent", filters.agent);
  }
  if (filters.status) {
    query.set("status", filters.status);
  }
  if (filters.after) {
    query.set("after", filters.after);
  }
  if (filters.limit !== undefined) {
    query.set("limit", String(filters.limit));
  }

  return requestJson<AppServerThreadListResponse>(
    apiBase,
    `/api/app-server/threads?${query.toString()}`,
    {
      headers: authHeaders(token),
    },
  );
}

export async function getAppServerThread(
  apiBase: string,
  token: string,
  threadId: string,
): Promise<AppServerThreadResponse> {
  return requestJson<AppServerThreadResponse>(
    apiBase,
    `/api/app-server/threads/${encodeURIComponent(threadId)}`,
    {
      headers: authHeaders(token),
    },
  );
}
