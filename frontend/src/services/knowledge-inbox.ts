import type {
  InboxItem,
  InboxListQuery,
  InboxPage,
  InboxStateChange,
} from "@runweave/shared/knowledge-inbox";
import { requestJson } from "./http";
export function fetchInbox(
  apiBase: string,
  token: string,
  query: InboxListQuery,
  signal?: AbortSignal,
): Promise<InboxPage> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return requestJson(apiBase, `/api/knowledge-inbox/items?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
}
export function fetchInboxItem(
  apiBase: string,
  token: string,
  id: string,
  version?: string,
  signal?: AbortSignal,
): Promise<InboxItem> {
  return requestJson(
    apiBase,
    `/api/knowledge-inbox/items/${encodeURIComponent(id)}${version ? `?contentVersion=${encodeURIComponent(version)}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
}
export function changeInboxState(
  apiBase: string,
  token: string,
  id: string,
  input: InboxStateChange,
): Promise<InboxItem> {
  return requestJson(
    apiBase,
    `/api/knowledge-inbox/items/${encodeURIComponent(id)}/state`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}
/** Used only for cache partitioning. The Backend verifies the token on every request. */
export function inboxAccount(token: string): string {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/gu, "+").replace(/_/gu, "/")),
    ) as { sub?: string };
    return payload.sub ?? "unknown";
  } catch {
    return "unknown";
  }
}
