import type {
  ChangeSupervisionRequest,
  StartSupervisionRequest,
  SupervisionDiscovery,
  TaskWatch,
  SupervisionDecisionDetail,
  SupervisionDecisionPage,
} from "@runweave/shared/task-supervision";
import { requestJson } from "./http";
export function fetchTaskSupervision(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string | null,
  signal?: AbortSignal,
): Promise<SupervisionDiscovery> {
  const query = new URLSearchParams({
    terminalSessionId,
    ...(panelId ? { panelId } : {}),
  });
  return requestJson(apiBase, `/api/task-supervision?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
}
export function startTaskSupervision(
  apiBase: string,
  token: string,
  request: StartSupervisionRequest,
): Promise<TaskWatch> {
  return requestJson(apiBase, "/api/task-supervision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}
export function changeTaskSupervision(
  apiBase: string,
  token: string,
  watchId: string,
  request: ChangeSupervisionRequest,
): Promise<TaskWatch> {
  return requestJson(
    apiBase,
    `/api/task-supervision/${encodeURIComponent(watchId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
}
export function getTaskWatch(
  apiBase: string,
  token: string,
  watchId: string,
): Promise<TaskWatch> {
  return requestJson(
    apiBase,
    `/api/task-supervision/${encodeURIComponent(watchId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export function getSupervisionDecisions(apiBase: string, token: string, watchId: string, cursor?: string, signal?: AbortSignal): Promise<SupervisionDecisionPage> {
  const query = new URLSearchParams(cursor ? { cursor } : {});
  return requestJson(apiBase, `/api/task-supervision/${encodeURIComponent(watchId)}/decisions?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal });
}
export function getSupervisionDecision(apiBase: string, token: string, watchId: string, decisionId: string, signal?: AbortSignal): Promise<SupervisionDecisionDetail> {
  return requestJson(apiBase, `/api/task-supervision/${encodeURIComponent(watchId)}/decisions/${encodeURIComponent(decisionId)}`, { headers: { Authorization: `Bearer ${token}` }, signal });
}
