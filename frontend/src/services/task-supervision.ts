import type {
  ChangeSupervisionRequest,
  StartSupervisionRequest,
  SupervisionDiscovery,
  TaskWatch,
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
