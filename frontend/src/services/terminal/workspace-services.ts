import type {
  WorkspaceServiceListResponse,
  WorkspaceServiceMutationResponse,
} from "@runweave/shared/terminal/workspace-service";
import { HttpError, requestJson } from "../http";

export function isWorkspaceServicesLocalOnlyError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 403 &&
    error.code === "local_request_required"
  );
}

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
