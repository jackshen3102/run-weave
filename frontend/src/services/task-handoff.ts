import type {
  TaskHandoffCard,
  TaskHandoffResponse,
} from "@runweave/shared/task-handoff";
import { requestJson } from "./http";

export function fetchTaskHandoff(
  apiBase: string,
  token: string,
  sessionId: string,
  panelId: string | null,
  signal?: AbortSignal,
): Promise<TaskHandoffResponse> {
  const query = panelId ? `?panelId=${encodeURIComponent(panelId)}` : "";
  return requestJson(
    apiBase,
    `/api/task-handoff/${encodeURIComponent(sessionId)}${query}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
}
export function refreshTaskHandoff(
  apiBase: string,
  token: string,
  sessionId: string,
  panelId: string | null,
): Promise<TaskHandoffResponse> {
  return requestJson(
    apiBase,
    `/api/task-handoff/${encodeURIComponent(sessionId)}/refresh`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ panelId }),
    },
  );
}
export function editTaskHandoff(
  apiBase: string,
  token: string,
  card: TaskHandoffCard,
  goal: string,
): Promise<TaskHandoffCard> {
  return requestJson(
    apiBase,
    `/api/task-handoff/${encodeURIComponent(card.target.terminalSessionId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        panelId: card.target.panelId,
        threadId: card.target.threadId,
        revision: card.revision,
        goal,
      }),
    },
  );
}
