import type {
  WorkspaceServiceListResponse,
  WorkspaceServiceMutationResponse,
} from "@runweave/shared/terminal/workspace-service";
import { requestJson } from "../http";

function buildWorkspaceServicesPath(
  parentProjectId: string,
  projectId: string,
): string {
  return `/api/terminal/project/${encodeURIComponent(parentProjectId)}/contexts/${encodeURIComponent(projectId)}/services`;
}

export async function listTerminalWorkspaceServices(
  apiBase: string,
  token: string,
  parentProjectId: string,
  projectId: string,
): Promise<WorkspaceServiceListResponse> {
  return requestJson<WorkspaceServiceListResponse>(
    apiBase,
    buildWorkspaceServicesPath(parentProjectId, projectId),
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function startTerminalWorkspaceService(
  apiBase: string,
  token: string,
  parentProjectId: string,
  projectId: string,
  serviceName: string,
  configRevision: string,
): Promise<WorkspaceServiceMutationResponse> {
  return requestJson<WorkspaceServiceMutationResponse>(
    apiBase,
    `${buildWorkspaceServicesPath(parentProjectId, projectId)}/${encodeURIComponent(serviceName)}/start`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ configRevision }),
    },
  );
}

export async function stopTerminalWorkspaceService(
  apiBase: string,
  token: string,
  parentProjectId: string,
  projectId: string,
  serviceName: string,
): Promise<WorkspaceServiceMutationResponse> {
  return requestJson<WorkspaceServiceMutationResponse>(
    apiBase,
    `${buildWorkspaceServicesPath(parentProjectId, projectId)}/${encodeURIComponent(serviceName)}/stop`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}
