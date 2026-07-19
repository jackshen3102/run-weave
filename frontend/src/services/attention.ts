import type { AttentionSnapshot } from "@runweave/shared/attention";
import { requestJson } from "./http";

export function fetchAttentionSnapshot(
  apiBase: string,
  token: string,
  signal?: AbortSignal,
): Promise<AttentionSnapshot> {
  return requestJson(apiBase, "/api/attention/slots", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
}
