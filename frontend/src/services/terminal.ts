import type {
  CreateOrchestratorRunRequest,
  CreateTerminalProjectRequest,
  CreateTerminalClipboardImageRequest,
  CreateTerminalClipboardImageResponse,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalEventsWsTicketResponse,
  CreateTerminalWsTicketResponse,
  InjectOrchestratorPromptRequest,
  OrchestratorRoleDefinition,
  OrchestratorRolesResponse,
  OrchestratorRunPackage,
  OrchestratorRunsResponse,
  OrchestratorRunStatus,
  PreviewOrchestratorRunPromptResponse,
  SubmitOrchestratorRoundConfirmationRequest,
  SubmitOrchestratorHumanGateRequest,
  SendTerminalInputRequest,
  SendTerminalInputResponse,
  TerminalCompletionEventListResponse,
  TerminalPreviewChangeKind,
  TerminalPreviewDeleteFileRequest,
  TerminalPreviewDeleteFileResponse,
  TerminalPreviewDirectoryResponse,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewRenameFileRequest,
  TerminalPreviewSaveFileRequest,
  TerminalPreviewSaveFileResponse,
  TerminalPreviewFileSearchResponse,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  UpdateTerminalProjectRequest,
  UpdateTerminalSessionRequest,
} from "@runweave/shared";
import { requestBlob, requestJson, requestVoid } from "./http";

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

export async function updateTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: UpdateTerminalSessionRequest,
): Promise<TerminalSessionListItem> {
  return requestJson<TerminalSessionListItem>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
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

export async function listOrchestratorRoles(
  apiBase: string,
  token: string,
): Promise<OrchestratorRolesResponse> {
  return requestJson<OrchestratorRolesResponse>(
    apiBase,
    "/api/orchestrator/roles",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function saveOrchestratorRoles(
  apiBase: string,
  token: string,
  roles: OrchestratorRoleDefinition[],
): Promise<OrchestratorRolesResponse> {
  return requestJson<OrchestratorRolesResponse>(
    apiBase,
    "/api/orchestrator/roles",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ roles }),
    },
  );
}

export async function listOrchestratorRuns(
  apiBase: string,
  token: string,
  projectId: string,
): Promise<OrchestratorRunsResponse> {
  return requestJson<OrchestratorRunsResponse>(
    apiBase,
    `/api/orchestrator/runs?projectId=${encodeURIComponent(projectId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function createOrchestratorRun(
  apiBase: string,
  token: string,
  payload: CreateOrchestratorRunRequest,
): Promise<OrchestratorRunPackage> {
  return requestJson<OrchestratorRunPackage>(
    apiBase,
    "/api/orchestrator/runs",
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

export async function previewOrchestratorRunPrompt(
  apiBase: string,
  token: string,
  payload: CreateOrchestratorRunRequest,
): Promise<PreviewOrchestratorRunPromptResponse> {
  return requestJson<PreviewOrchestratorRunPromptResponse>(
    apiBase,
    "/api/orchestrator/runs/preview",
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

export async function injectOrchestratorPrompt(
  apiBase: string,
  token: string,
  runId: string,
  payload: InjectOrchestratorPromptRequest,
): Promise<OrchestratorRunPackage> {
  return requestJson<OrchestratorRunPackage>(
    apiBase,
    `/api/orchestrator/runs/${encodeURIComponent(runId)}/inject`,
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

export async function submitOrchestratorHumanGate(
  apiBase: string,
  token: string,
  runId: string,
  payload: SubmitOrchestratorHumanGateRequest,
): Promise<OrchestratorRunPackage> {
  return requestJson<OrchestratorRunPackage>(
    apiBase,
    `/api/orchestrator/runs/${encodeURIComponent(runId)}/human-gate`,
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

export async function submitOrchestratorRoundConfirmation(
  apiBase: string,
  token: string,
  runId: string,
  payload: SubmitOrchestratorRoundConfirmationRequest,
): Promise<OrchestratorRunPackage> {
  return requestJson<OrchestratorRunPackage>(
    apiBase,
    `/api/orchestrator/runs/${encodeURIComponent(runId)}/round-confirmation`,
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

export async function setOrchestratorRunStatus(
  apiBase: string,
  token: string,
  runId: string,
  status: OrchestratorRunStatus,
): Promise<OrchestratorRunPackage> {
  return requestJson<OrchestratorRunPackage>(
    apiBase,
    `/api/orchestrator/runs/${encodeURIComponent(runId)}/status`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status }),
    },
  );
}

export async function listTerminalCompletionEvents(
  apiBase: string,
  token: string,
  after: string | null,
): Promise<TerminalCompletionEventListResponse> {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  return requestJson<TerminalCompletionEventListResponse>(
    apiBase,
    `/api/terminal/completion-events${query}`,
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

export async function sendTerminalInput(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: SendTerminalInputRequest,
): Promise<SendTerminalInputResponse> {
  return requestJson<SendTerminalInputResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/input`,
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

export async function reorderTerminalProjects(
  apiBase: string,
  token: string,
  orderedIds: string[],
): Promise<void> {
  return requestVoid(
    apiBase,
    "/api/terminal/project/reorder",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderedIds }),
    },
  );
}

export async function reorderTerminalSessions(
  apiBase: string,
  token: string,
  projectId: string,
  orderedIds: string[],
): Promise<void> {
  return requestVoid(
    apiBase,
    "/api/terminal/session/reorder",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId, orderedIds }),
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

export async function createTerminalEventsWsTicket(
  apiBase: string,
  token: string,
): Promise<CreateTerminalEventsWsTicketResponse> {
  return requestJson<CreateTerminalEventsWsTicketResponse>(
    apiBase,
    "/api/terminal/events/ws-ticket",
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
