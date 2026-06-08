import type {
  CreateTerminalWsTicketResponse,
  SendTerminalInputResponse,
  TerminalMobileOverviewResponse,
  TerminalSessionStatusResponse,
} from "@browser-viewer/shared";

import { requestJson } from "./http";

export async function getTerminalMobileOverview(
  apiBase: string,
  accessToken: string,
): Promise<TerminalMobileOverviewResponse> {
  return requestJson<TerminalMobileOverviewResponse>(
    apiBase,
    "/api/terminal/mobile/overview?includeTail=false",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function getTerminalSession(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<TerminalSessionStatusResponse> {
  return requestJson<TerminalSessionStatusResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function createTerminalWsTicket(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<CreateTerminalWsTicketResponse> {
  return requestJson<CreateTerminalWsTicketResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/ws-ticket`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function sendTerminalInput(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
  data: string,
): Promise<SendTerminalInputResponse> {
  return requestJson<SendTerminalInputResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/input`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data }),
    },
  );
}
