import type {
  CreateDevtoolsTicketRequest,
  CreateDevtoolsTicketResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionListItem,
  UpdateSessionRequest,
  SessionStatusResponse,
} from "@browser-viewer/shared";
import { requestJson, requestVoid } from "./http";

export async function createSession(
  apiBase: string,
  payload: CreateSessionRequest,
  token: string,
): Promise<CreateSessionResponse> {
  return requestJson<CreateSessionResponse>(apiBase, "/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

export async function listSessions(
  apiBase: string,
  token: string,
): Promise<SessionListItem[]> {
  return requestJson<SessionListItem[]>(apiBase, "/api/session", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function deleteSession(
  apiBase: string,
  token: string,
  sessionId: string,
): Promise<void> {
  return requestVoid(apiBase, `/api/session/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function updateSession(
  apiBase: string,
  token: string,
  sessionId: string,
  payload: UpdateSessionRequest,
): Promise<SessionStatusResponse> {
  return requestJson<SessionStatusResponse>(
    apiBase,
    `/api/session/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function createDevtoolsTicket(
  apiBase: string,
  token: string,
  sessionId: string,
  payload: CreateDevtoolsTicketRequest,
): Promise<CreateDevtoolsTicketResponse> {
  return requestJson<CreateDevtoolsTicketResponse>(
    apiBase,
    `/api/session/${encodeURIComponent(sessionId)}/devtools-ticket`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}
