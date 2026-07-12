import type {
  ActivityDataPolicyDto,
  ActivityContentValueDto,
  ActivityDeleteJobDto,
  ActivityFactsPage,
  ActivityFactsQuery,
  ActivitySourceDto,
  ActivityTimelineSelector,
  ActivityOperationAction,
  ActivityOperationScope,
} from "@runweave/shared/activity";
import { requestJson } from "./http";

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function queryString(values: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export function fetchActivityFacts(
  apiBase: string,
  token: string,
  query: ActivityFactsQuery,
): Promise<ActivityFactsPage> {
  return requestJson(
    apiBase,
    `/api/activity/facts${queryString({
      runtimeChannel: query.runtimeChannel,
      runtimeSurface: query.runtimeSurface,
      projectId: query.projectId,
      terminalSessionId: query.terminalSessionId,
      threadId: query.threadId,
      runId: query.runId,
      eventName: query.eventName,
      actorType: query.actorType,
      resultStatus: query.resultStatus,
      search: query.search,
      cursor: query.cursor,
      asOfActivityOffset: query.asOfActivityOffset,
      limit: query.limit,
    })}`,
    { headers: authHeaders(token) },
  );
}

export function fetchActivityTimeline(
  apiBase: string,
  token: string,
  selector: ActivityTimelineSelector,
  query: Pick<ActivityFactsQuery, "cursor" | "asOfActivityOffset" | "limit"> = {},
): Promise<ActivityFactsPage> {
  return requestJson(
    apiBase,
    `/api/activity/timelines${queryString({
      selector: selector.type,
      id: selector.id,
      cursor: query.cursor,
      asOfActivityOffset: query.asOfActivityOffset,
      limit: query.limit,
    })}`,
    { headers: authHeaders(token) },
  );
}

export async function fetchActivitySources(
  apiBase: string,
  token: string,
): Promise<ActivitySourceDto[]> {
  const response = await requestJson<{ sources: ActivitySourceDto[] }>(
    apiBase,
    "/api/activity/sources",
    { headers: authHeaders(token) },
  );
  return response.sources;
}

export function fetchActivityPolicy(
  apiBase: string,
  token: string,
): Promise<ActivityDataPolicyDto> {
  return requestJson(apiBase, "/api/activity/policy", {
    headers: authHeaders(token),
  });
}

export function fetchActivityContent(
  apiBase: string,
  token: string,
  contentId: string,
): Promise<ActivityContentValueDto> {
  return requestJson(
    apiBase,
    `/api/activity/contents/${encodeURIComponent(contentId)}`,
    { headers: authHeaders(token) },
  );
}

export function executeActivityOperation(
  apiBase: string,
  token: string,
  action: ActivityOperationAction,
  scope: ActivityOperationScope,
): Promise<unknown> {
  return requestJson(apiBase, "/api/activity/operations", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ action, scope }),
  });
}

export function fetchActivityDeleteJob(
  apiBase: string,
  token: string,
  deleteJobId: string,
): Promise<ActivityDeleteJobDto> {
  return requestJson(
    apiBase,
    `/api/activity/delete-jobs/${encodeURIComponent(deleteJobId)}`,
    { headers: authHeaders(token) },
  );
}
