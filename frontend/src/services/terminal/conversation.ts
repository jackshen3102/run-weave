import type { TerminalConversationResponse } from "@runweave/shared/terminal/conversation";
import { requestJson } from "../http";

export function getTerminalConversation(apiBase: string, token: string, sessionId: string,
  query: { panelId?: string | null; expectedThreadId?: string }, signal: AbortSignal) {
  const params = new URLSearchParams();
  if (query.panelId) params.set("panelId", query.panelId);
  if (query.expectedThreadId) params.set("expectedThreadId", query.expectedThreadId);
  return requestJson<TerminalConversationResponse>(apiBase,
    `/api/terminal/session/${encodeURIComponent(sessionId)}/conversation?${params}`, {
      headers: { Authorization: `Bearer ${token}` }, signal, cache: "no-store",
    });
}
