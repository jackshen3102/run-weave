import type {
  AppHomeOverviewResponse,
  CreateTerminalProjectRequest,
  TerminalProjectListItem,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalClipboardImageRequest,
  CreateTerminalClipboardImageResponse,
  CreateTerminalEventsWsTicketResponse,
  CreateTerminalWsTicketResponse,
  SendTerminalInterruptResponse,
  SendTerminalInputResponse,
  TerminalInputMode,
  TerminalPreviewChangeKind,
  TerminalPreviewDirectoryResponse,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchResponse,
  TerminalPreviewGitChangesResponse,
  TerminalSessionHistoryResponse,
  TerminalSessionStatusResponse,
  TerminalStateResponse,
} from "@runweave/shared";

import { requestBlob, requestJson, requestVoid } from "./http";

export async function getAppHomeOverview(
  apiBase: string,
  accessToken: string,
): Promise<AppHomeOverviewResponse> {
  return requestJson<AppHomeOverviewResponse>(
    apiBase,
    "/api/app/home/overview",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function createTerminalProject(
  apiBase: string,
  accessToken: string,
  payload: CreateTerminalProjectRequest,
): Promise<TerminalProjectListItem> {
  return requestJson<TerminalProjectListItem>(apiBase, "/api/terminal/project", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function getTerminalSession(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<TerminalSessionStatusResponse> {
  return requestJson<TerminalSessionStatusResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function getTerminalHistory(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<TerminalSessionHistoryResponse> {
  return requestJson<TerminalSessionHistoryResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/history`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function createTerminalSession(
  apiBase: string,
  accessToken: string,
  payload: CreateTerminalSessionRequest,
): Promise<CreateTerminalSessionResponse> {
  return requestJson<CreateTerminalSessionResponse>(
    apiBase,
    "/api/terminal/session",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteTerminalSession(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function getCurrentTerminalState(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<TerminalStateResponse> {
  return requestJson<TerminalStateResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/state`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function createTerminalWsTicket(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<CreateTerminalWsTicketResponse> {
  return requestJson<CreateTerminalWsTicketResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/ws-ticket`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function createTerminalEventsWsTicket(
  apiBase: string,
  accessToken: string,
): Promise<CreateTerminalEventsWsTicketResponse> {
  return requestJson<CreateTerminalEventsWsTicketResponse>(
    apiBase,
    "/api/terminal/events/ws-ticket",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function sendTerminalInput(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
  data: string,
  mode?: TerminalInputMode,
): Promise<SendTerminalInputResponse> {
  return requestJson<SendTerminalInputResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/input`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mode ? { data, mode } : { data }),
    },
  );
}

export async function interruptTerminalSession(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
): Promise<SendTerminalInterruptResponse> {
  return requestJson<SendTerminalInterruptResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/interrupt`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
}

export async function createTerminalSessionClipboardImage(
  apiBase: string,
  accessToken: string,
  terminalSessionId: string,
  payload: CreateTerminalClipboardImageRequest,
): Promise<CreateTerminalClipboardImageResponse> {
  return requestJson<CreateTerminalClipboardImageResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/clipboard-image`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function getTerminalProjectPreviewGitChanges(
  apiBase: string,
  accessToken: string,
  projectId: string,
): Promise<TerminalPreviewGitChangesResponse> {
  return requestJson<TerminalPreviewGitChangesResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/git-changes`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function getTerminalProjectPreviewFileDiff(
  apiBase: string,
  accessToken: string,
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
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function listTerminalProjectPreviewDirectory(
  apiBase: string,
  accessToken: string,
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
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function searchTerminalProjectPreviewFiles(
  apiBase: string,
  accessToken: string,
  projectId: string,
  params: { query: string; limit?: number },
): Promise<TerminalPreviewFileSearchResponse> {
  const query = new URLSearchParams({ q: params.query });
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }

  return requestJson<TerminalPreviewFileSearchResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/files/search?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function getTerminalProjectPreviewFile(
  apiBase: string,
  accessToken: string,
  projectId: string,
  filePath: string,
): Promise<TerminalPreviewFileResponse> {
  const query = new URLSearchParams({ path: filePath });
  return requestJson<TerminalPreviewFileResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function getTerminalProjectPreviewAsset(
  apiBase: string,
  accessToken: string,
  projectId: string,
  filePath: string,
): Promise<Blob> {
  const query = new URLSearchParams({ path: filePath });
  return requestBlob(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/asset?${query.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}
