import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
} from "@browser-viewer/shared";
import { requestJson, requestVoid } from "./http";

export async function createTerminalSession(
  apiBase: string,
  token: string,
  payload: CreateTerminalSessionRequest,
): Promise<CreateTerminalSessionResponse> {
  return requestJson<CreateTerminalSessionResponse>(
    apiBase,
    "/api/terminal/session",
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

export async function listTerminalSessions(
  apiBase: string,
  token: string,
): Promise<TerminalSessionListItem[]> {
  return requestJson<TerminalSessionListItem[]>(
    apiBase,
    "/api/terminal/session",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalSessionStatusResponse> {
  return requestJson<TerminalSessionStatusResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function deleteTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
