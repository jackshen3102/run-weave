import type {
  CreateTerminalPanelRequest,
  ResizeTerminalPanelRequest,
  TerminalPanelWorkspace,
} from "@runweave/shared/terminal/panel";
import type { TerminalSessionHistoryResponse } from "@runweave/shared/terminal/session";
import { requestJson } from "../http";

export async function listTerminalPanels(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function createTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: CreateTerminalPanelRequest,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels`,
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

export async function focusTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
  signal?: AbortSignal,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ focus: true }),
      signal,
    },
  );
}

export async function closeTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function resizeTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
  payload: ResizeTerminalPanelRequest,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}/resize`,
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

export async function getTerminalPanelHistory(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
): Promise<TerminalSessionHistoryResponse> {
  return requestJson<TerminalSessionHistoryResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}/history`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
