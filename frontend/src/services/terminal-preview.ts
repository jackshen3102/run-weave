import type {
  TerminalPreviewChangeKind,
  TerminalPreviewDeleteFileRequest,
  TerminalPreviewDeleteFileResponse,
  TerminalPreviewDirectoryResponse,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchResponse,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewRenameFileRequest,
  TerminalPreviewSaveFileRequest,
  TerminalPreviewSaveFileResponse,
} from "@runweave/shared";
import { requestBlob, requestJson } from "./http";

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

export async function saveTerminalProjectPreviewFile(
  apiBase: string,
  token: string,
  projectId: string,
  payload: TerminalPreviewSaveFileRequest,
): Promise<TerminalPreviewSaveFileResponse> {
  return requestJson<TerminalPreviewSaveFileResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteTerminalProjectPreviewFile(
  apiBase: string,
  token: string,
  projectId: string,
  payload: TerminalPreviewDeleteFileRequest,
): Promise<TerminalPreviewDeleteFileResponse> {
  return requestJson<TerminalPreviewDeleteFileResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function renameTerminalProjectPreviewFile(
  apiBase: string,
  token: string,
  projectId: string,
  payload: TerminalPreviewRenameFileRequest,
): Promise<TerminalPreviewFileResponse> {
  return requestJson<TerminalPreviewFileResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file/path`,
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

export async function getTerminalProjectPreviewAsset(
  apiBase: string,
  token: string,
  projectId: string,
  filePath: string,
): Promise<Blob> {
  const query = new URLSearchParams({ path: filePath });
  return requestBlob(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/asset?${query.toString()}`,
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

export async function listTerminalProjectPreviewDirectory(
  apiBase: string,
  token: string,
  projectId: string,
  params: { path?: string; limit?: number },
): Promise<TerminalPreviewDirectoryResponse> {
  const query = new URLSearchParams();
  if (params.path) {
    query.set("path", params.path);
  }
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }

  return requestJson<TerminalPreviewDirectoryResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/directory?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}
