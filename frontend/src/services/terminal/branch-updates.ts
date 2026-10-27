import type { BranchUpdatesResponse } from "@runweave/shared/terminal/branch-updates";
import { requestJson } from "../http";

export function getProjectBranchUpdates(apiBase: string, token: string, projectId: string,
  refresh: boolean, signal: AbortSignal): Promise<BranchUpdatesResponse> {
  return requestJson(apiBase, `/api/terminal/project/${encodeURIComponent(projectId)}/branch-updates?refresh=${refresh}`, {
    headers: { Authorization: `Bearer ${token}` }, signal,
  });
}
