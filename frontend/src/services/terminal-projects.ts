import type {
  CreateTerminalProjectRequest,
  TerminalProjectListItem,
  UpdateTerminalProjectRequest,
} from "@runweave/shared/terminal/project";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import { requestJson, requestVoid } from "./http";

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

export async function deleteTerminalWorktree(
  apiBase: string,
  token: string,
  parentProjectId: string,
  childProjectId: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(parentProjectId)}/contexts/${encodeURIComponent(childProjectId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
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
