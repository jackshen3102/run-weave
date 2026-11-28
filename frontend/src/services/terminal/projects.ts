import type {
  CreateTerminalProjectRequest,
  TerminalProjectListItem,
  UpdateTerminalProjectRequest,
} from "@runweave/shared/terminal/project";
import type {
  BatchCleanupWorktreesRequest,
  BatchCleanupWorktreesResponse,
  CreateWorktreeContextRequest,
  CreateWorktreeContextResponse,
  RecycleWorktreeRequest,
  RecycleWorktreeResponse,
  TerminalProjectContextBranchStatusRequest,
  TerminalProjectContextBranchStatusResponse,
  TerminalProjectContextListItem,
  TerminalWorktreeDeletionResult,
  WorktreeCreatePreviewResponse,
  WorktreeGovernanceResponse,
} from "@runweave/shared/terminal/project-context";
import { requestJson, requestText, requestVoid } from "../http";

export async function createTerminalProject(
  apiBase: string,
  token: string,
  payload: CreateTerminalProjectRequest,
): Promise<TerminalProjectListItem> {
  return requestJson<TerminalProjectListItem>(
    apiBase,
    "/api/terminal/project",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function listTerminalProjects(
  apiBase: string,
  token: string,
): Promise<TerminalProjectListItem[]> {
  return requestJson<TerminalProjectListItem[]>(
    apiBase,
    "/api/terminal/project",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function listTerminalProjectContexts(
  apiBase: string,
  token: string,
  parentProjectId: string,
): Promise<TerminalProjectContextListItem[]> {
  return requestJson<TerminalProjectContextListItem[]>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parentProjectId)}/contexts`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function updateTerminalProjectContext(
  apiBase: string,
  token: string,
  parentProjectId: string,
  childProjectId: string,
  pinned: boolean,
): Promise<TerminalProjectContextListItem> {
  return requestJson<TerminalProjectContextListItem>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parentProjectId)}/contexts/${encodeURIComponent(childProjectId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pinned }),
    },
  );
}

export async function getTerminalProjectContextBranchStatuses(
  apiBase: string,
  token: string,
  parentProjectId: string,
  payload: TerminalProjectContextBranchStatusRequest,
): Promise<TerminalProjectContextBranchStatusResponse> {
  return requestJson(apiBase,
    `/api/terminal/project/${encodeURIComponent(parentProjectId)}/contexts/branch-status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
}

export async function deleteTerminalWorktree(
  apiBase: string,
  token: string,
  parentProjectId: string,
  childProjectId: string,
): Promise<TerminalWorktreeDeletionResult> {
  const body = await requestText(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parentProjectId)}/contexts/${encodeURIComponent(childProjectId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  // Older Backends and successful cleanup return 204 with no body.
  return body.trim()
    ? JSON.parse(body) as TerminalWorktreeDeletionResult
    : { cleanupWarnings: [] };
}

export async function deleteTerminalProject(
  apiBase: string,
  token: string,
  projectId: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function updateTerminalProject(
  apiBase: string,
  token: string,
  projectId: string,
  payload: UpdateTerminalProjectRequest,
): Promise<TerminalProjectListItem> {
  return requestJson<TerminalProjectListItem>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function reorderTerminalProjects(
  apiBase: string,
  token: string,
  orderedIds: string[],
): Promise<void> {
  return requestVoid(apiBase, "/api/terminal/project/reorder", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderedIds }),
  });
}

export function previewWorktreeCreation(apiBase: string, token: string, parent: string) {
  return requestJson<WorktreeCreatePreviewResponse>(apiBase,
    `/api/terminal/project/${encodeURIComponent(parent)}/worktree-create-preview`,
    { headers: { Authorization: `Bearer ${token}` } });
}

export function createWorktreeContext(apiBase: string, token: string, parent: string, request: CreateWorktreeContextRequest) {
  return requestJson<CreateWorktreeContextResponse>(apiBase, `/api/terminal/project/${encodeURIComponent(parent)}/contexts`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
  });
}

export function getWorktreeGovernance(
  apiBase: string,
  token: string,
  parent: string,
  includeDiskUsage = false,
) {
  const query = includeDiskUsage ? "?includeDiskUsage=true" : "";
  return requestJson<WorktreeGovernanceResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parent)}/worktree-governance${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export function batchCleanupWorktrees(
  apiBase: string,
  token: string,
  parent: string,
  request: BatchCleanupWorktreesRequest,
) {
  return requestJson<BatchCleanupWorktreesResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parent)}/worktree-cleanup-batch`,
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

export function recycleWorktreeContext(
  apiBase: string,
  token: string,
  parent: string,
  childProjectId: string,
  request: RecycleWorktreeRequest,
) {
  return requestJson<RecycleWorktreeResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parent)}/contexts/${encodeURIComponent(childProjectId)}/recycle`,
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
