import type { TerminalUnreadSnapshot } from "@runweave/shared/terminal-unread";
import { requestJson } from "../http";

export function fetchTerminalUnread(apiBase: string, token: string, signal: AbortSignal): Promise<TerminalUnreadSnapshot> {
  return requestJson(apiBase, "/api/terminal/unread", {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
  });
}
