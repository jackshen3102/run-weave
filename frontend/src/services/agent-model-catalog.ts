import type { AgentModelCatalogsResponse } from "@runweave/shared/agent-model-catalog";
import { requestJson } from "./http";

export function getAgentModelCatalogs(
  apiBase: string,
  token: string,
  signal?: AbortSignal,
): Promise<AgentModelCatalogsResponse> {
  return requestJson<AgentModelCatalogsResponse>(
    apiBase,
    "/api/agent-model-catalogs",
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
}
