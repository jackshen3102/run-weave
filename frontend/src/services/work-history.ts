import type {
  AgentTeamArchiveDetail,
  AgentTeamArchivePage,
  TerminalArchiveDetail,
  TerminalArchivePage,
} from "@runweave/shared/work-history";
import { requestJson } from "./http";

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function queryString(values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function fetchTerminalArchives(
  apiBase: string,
  token: string,
  options: { search?: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
): Promise<TerminalArchivePage> {
  return requestJson(
    apiBase,
    `/api/work-history/terminals${queryString(options)}`,
    { headers: authHeaders(token), signal },
  );
}

export function fetchTerminalArchive(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  options: {
    activityCursor?: string;
    asOfActivityOffset?: number;
    threadCursor?: string;
    includeActivity?: boolean;
    includeThreadDetails?: boolean;
  } = {},
  signal?: AbortSignal,
): Promise<TerminalArchiveDetail> {
  return requestJson(
    apiBase,
    `/api/work-history/terminals/${encodeURIComponent(terminalSessionId)}${queryString(options)}`,
    { headers: authHeaders(token), signal },
  );
}

export function fetchAgentTeamArchives(
  apiBase: string,
  token: string,
  options: { search?: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
): Promise<AgentTeamArchivePage> {
  return requestJson(
    apiBase,
    `/api/work-history/runs${queryString(options)}`,
    { headers: authHeaders(token), signal },
  );
}

export function fetchAgentTeamArchive(
  apiBase: string,
  token: string,
  runId: string,
  options: { activityCursor?: string; asOfActivityOffset?: number } = {},
  signal?: AbortSignal,
): Promise<AgentTeamArchiveDetail> {
  return requestJson(
    apiBase,
    `/api/work-history/runs/${encodeURIComponent(runId)}${queryString(options)}`,
    { headers: authHeaders(token), signal },
  );
}
