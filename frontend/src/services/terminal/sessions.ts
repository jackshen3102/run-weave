import type {
  PrepareTerminalAgentRequest,
  PrepareTerminalAgentResponse,
  RecoverTerminalAgentRequest,
  RecoverTerminalAgentResponse,
} from "@runweave/shared/terminal/agent-preparation";
import type { TerminalStateResponse } from "@runweave/shared/terminal/events";
import type {
  CreateTerminalClipboardImageRequest,
  CreateTerminalClipboardImageResponse,
  SendTerminalInputRequest,
  SendTerminalInputResponse,
} from "@runweave/shared/terminal/input";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalEventsWsTicketResponse,
  CreateTerminalWsTicketResponse,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  UpdateTerminalSessionRequest,
} from "@runweave/shared/terminal/session";
import { requestJson, requestVoid } from "../http";
import type { TerminalCompletionViewedRequest } from "@runweave/shared/terminal/completion";

export async function reportTerminalCompletionViewed(
  apiBase: string, token: string, terminalSessionId: string, payload: TerminalCompletionViewedRequest,
): Promise<void> {
  return requestVoid(apiBase, `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/completion-viewed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function createTerminalSession(
  apiBase: string,
  token: string,
  payload: CreateTerminalSessionRequest,
): Promise<CreateTerminalSessionResponse> {
  void window.electronAPI?.checkAppServer?.().catch(() => {
    // Health prompts are advisory; terminal creation must continue.
  });
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
  signal?: AbortSignal,
): Promise<TerminalSessionListItem[]> {
  return requestJson<TerminalSessionListItem[]>(
    apiBase,
    "/api/terminal/session",
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );
}

export async function updateTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: UpdateTerminalSessionRequest,
  signal?: AbortSignal,
): Promise<TerminalSessionListItem> {
  return requestJson<TerminalSessionListItem>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal,
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
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function getTerminalState(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalStateResponse> {
  return requestJson<TerminalStateResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/state`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function sendTerminalInput(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: SendTerminalInputRequest,
  signal?: AbortSignal,
): Promise<SendTerminalInputResponse> {
  return requestJson<SendTerminalInputResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/input`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal,
    },
  );
}

export async function getTerminalHistory(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalSessionHistoryResponse> {
  return requestJson<TerminalSessionHistoryResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/history`,
    { headers: { Authorization: `Bearer ${token}` } },
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
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function reorderTerminalSessions(
  apiBase: string,
  token: string,
  projectId: string,
  orderedIds: string[],
): Promise<void> {
  return requestVoid(apiBase, "/api/terminal/session/reorder", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ projectId, orderedIds }),
  });
}

export async function prepareTerminalAgent(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: PrepareTerminalAgentRequest,
): Promise<PrepareTerminalAgentResponse> {
  return requestJson<PrepareTerminalAgentResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/agent/prepare`,
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

export async function recoverTerminalAgent(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: RecoverTerminalAgentRequest,
): Promise<RecoverTerminalAgentResponse> {
  return requestJson<RecoverTerminalAgentResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/agent/recover`,
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

export async function createTerminalWsTicket(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<CreateTerminalWsTicketResponse> {
  return requestJson<CreateTerminalWsTicketResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/ws-ticket`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function createTerminalEventsWsTicket(
  apiBase: string,
  token: string,
): Promise<CreateTerminalEventsWsTicketResponse> {
  return requestJson<CreateTerminalEventsWsTicketResponse>(
    apiBase,
    "/api/terminal/events/ws-ticket",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function createTerminalSessionClipboardImage(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: CreateTerminalClipboardImageRequest,
  signal?: AbortSignal,
): Promise<CreateTerminalClipboardImageResponse> {
  return requestJson<CreateTerminalClipboardImageResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/clipboard-image`,
    {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function terminalTextAttachmentRequest<T>(
  apiBase: string, token: string, sessionId: string, suffix: string,
  method = "GET", payload?: unknown,
): Promise<T> {
  return requestJson<T>(apiBase, `/api/terminal/session/${encodeURIComponent(sessionId)}/text-attachments${suffix}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(20_000),
  });
}

export async function terminalTextAttachmentAction(
  apiBase: string, token: string, sessionId: string, id: string, action: "release" | "retain",
): Promise<void> {
  return requestVoid(apiBase, `/api/terminal/session/${encodeURIComponent(sessionId)}/text-attachments/${encodeURIComponent(id)}${action === "retain" ? "/retain" : ""}`, {
    method: action === "retain" ? "POST" : "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  });
}

export async function readTerminalTextAttachment(
  apiBase: string, token: string, sessionId: string, attachment: import("@runweave/shared/terminal/text-attachments").TerminalTextAttachment,
): Promise<string> {
  const { requestText } = await import("../http");
  const text = await requestText(apiBase, `/api/terminal/session/${encodeURIComponent(sessionId)}/text-attachments/${encodeURIComponent(attachment.id)}/content`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  });
  const bytes = new TextEncoder().encode(text);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (text.length !== attachment.utf16Length || bytes.length !== attachment.utf8Bytes || hash !== attachment.sha256) throw new Error("附件内容校验失败");
  return text;
}
