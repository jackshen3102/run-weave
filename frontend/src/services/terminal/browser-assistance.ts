import type { BrowserAssistanceRequest } from "@runweave/shared/terminal-browser-assistance";
import { requestJson } from "../http";

function path(sessionId: string) {
  return `/api/terminal/session/${encodeURIComponent(sessionId)}/browser-assistance`;
}

export function listBrowserAssistance(
  apiBase: string,
  token: string,
  sessionId: string,
  signal: AbortSignal,
) {
  return requestJson<BrowserAssistanceRequest[]>(apiBase, path(sessionId), {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
}

export function updateBrowserAssistance(
  apiBase: string,
  token: string,
  request: BrowserAssistanceRequest,
  action: "resume" | "cancel",
) {
  return requestJson<BrowserAssistanceRequest>(
    apiBase,
    `${path(request.terminalSessionId)}/${encodeURIComponent(request.requestId)}/${action}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export function importScheduledBrowserAssistance(
  apiBase: string,
  token: string,
  sessionId: string,
  runId: string,
  signal: AbortSignal,
) {
  return requestJson<BrowserAssistanceRequest | null>(
    apiBase,
    `${path(sessionId)}/from-scheduled-run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId }),
      signal,
    },
  );
}
