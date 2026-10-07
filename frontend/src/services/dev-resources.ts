import type {
  DevResourcesSnapshot,
  ReleaseDevResourceRequest,
  ReleaseDevResourceResult,
} from "@runweave/shared/dev-resources";
import { requestJson } from "./http";

export function getDevResources(
  apiBase: string,
  token: string,
  signal: AbortSignal,
): Promise<DevResourcesSnapshot> {
  return requestJson(apiBase, "/api/dev-resources", {
    signal,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function releaseDevResource(
  apiBase: string,
  token: string,
  resourceId: string,
  request: ReleaseDevResourceRequest,
): Promise<ReleaseDevResourceResult> {
  return requestJson(
    apiBase,
    `/api/dev-resources/${encodeURIComponent(resourceId)}/release`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
}
