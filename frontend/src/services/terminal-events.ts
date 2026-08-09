import type { TerminalCompletionEventListResponse } from "@runweave/shared/terminal/events";
import { requestJson } from "./http";

export async function listTerminalCompletionEvents(
  apiBase: string,
  token: string,
  after: string | null,
): Promise<TerminalCompletionEventListResponse> {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  return requestJson<TerminalCompletionEventListResponse>(
    apiBase,
    `/api/terminal/completion-events${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
