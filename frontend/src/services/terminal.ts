import type {
  CreateTerminalProjectRequest,
  CreateTerminalClipboardImageRequest,
  CreateTerminalClipboardImageResponse,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalWsTicketResponse,
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchResponse,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  UpdateTerminalProjectRequest,
} from "@browser-viewer/shared";
import { requestJson, requestVoid } from "./http";

export async function createTerminalProject(
  apiBase: string,
  token: string,
  payload: CreateTerminalProjectRequest,
): Promise<TerminalProjectListItem> {
  return requestJson<TerminalProjectListItem>(apiBase, "/api/terminal/project", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

export async function createTerminalSession(
  apiBase: string,
  token: string,
  payload: CreateTerminalSessionRequest,
): Promise<CreateTerminalSessionResponse> {
  return requestJson<CreateTerminalSessionResponse>(
    apiBase,
    "/api/terminal/session",
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
  return requestJson<TerminalProjectListItem[]>(apiBase, "/api/terminal/project", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function listTerminalSessions(
  apiBase: string,
  token: string,
): Promise<TerminalSessionListItem[]> {
  return requestJson<TerminalSessionListItem[]>(
    apiBase,
    "/api/terminal/session",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
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

export async function getTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalSessionStatusResponse> {
  return requestJson<TerminalSessionStatusResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalHistory(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalSessionHistoryResponse> {
  return requestJson<TerminalSessionHistoryResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/history`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function deleteTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function createTerminalWsTicket(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<CreateTerminalWsTicketResponse> {
  return requestJson<CreateTerminalWsTicketResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/ws-ticket`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function createTerminalSessionClipboardImage(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: CreateTerminalClipboardImageRequest,
): Promise<CreateTerminalClipboardImageResponse> {
  return requestJson<CreateTerminalClipboardImageResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/clipboard-image`,
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

export async function searchTerminalPreviewFiles(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  params: { query: string; limit?: number },
): Promise<TerminalPreviewFileSearchResponse> {
  const query = new URLSearchParams();
  query.set("q", params.query);
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }

  return requestJson<TerminalPreviewFileSearchResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/preview/files/search?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function searchTerminalProjectPreviewFiles(
  apiBase: string,
  token: string,
  projectId: string,
  params: { query: string; limit?: number },
): Promise<TerminalPreviewFileSearchResponse> {
  const query = new URLSearchParams();
  query.set("q", params.query);
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }

  return requestJson<TerminalPreviewFileSearchResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/files/search?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalPreviewFile(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  filePath: string,
): Promise<TerminalPreviewFileResponse> {
  const query = new URLSearchParams({ path: filePath });
  return requestJson<TerminalPreviewFileResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/preview/file?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalProjectPreviewFile(
  apiBase: string,
  token: string,
  projectId: string,
  filePath: string,
): Promise<TerminalPreviewFileResponse> {
  const query = new URLSearchParams({ path: filePath });
  return requestJson<TerminalPreviewFileResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalPreviewGitChanges(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalPreviewGitChangesResponse> {
  return requestJson<TerminalPreviewGitChangesResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/preview/git-changes`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalProjectPreviewGitChanges(
  apiBase: string,
  token: string,
  projectId: string,
): Promise<TerminalPreviewGitChangesResponse> {
  return requestJson<TerminalPreviewGitChangesResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/git-changes`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalPreviewFileDiff(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  params: { path: string; kind: TerminalPreviewChangeKind },
): Promise<TerminalPreviewFileDiffResponse> {
  const query = new URLSearchParams({
    path: params.path,
    kind: params.kind,
  });
  return requestJson<TerminalPreviewFileDiffResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/preview/file-diff?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function getTerminalProjectPreviewFileDiff(
  apiBase: string,
  token: string,
  projectId: string,
  params: { path: string; kind: TerminalPreviewChangeKind },
): Promise<TerminalPreviewFileDiffResponse> {
  const query = new URLSearchParams({
    path: params.path,
    kind: params.kind,
  });
  return requestJson<TerminalPreviewFileDiffResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file-diff?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
