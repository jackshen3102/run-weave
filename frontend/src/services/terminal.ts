import type { TerminalCompletionEventListResponse, TerminalStateResponse } from "@runweave/shared/terminal/events";
import type { PrepareTerminalAgentRequest, PrepareTerminalAgentResponse, RecoverTerminalAgentRequest, RecoverTerminalAgentResponse } from "@runweave/shared/terminal/agent-preparation";
import type { CreateTerminalClipboardImageRequest, CreateTerminalClipboardImageResponse, SendTerminalInputRequest, SendTerminalInputResponse } from "@runweave/shared/terminal/input";
import type { CreateTerminalPanelRequest, ResizeTerminalPanelRequest, TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { CreateTerminalProjectRequest, TerminalProjectListItem, UpdateTerminalProjectRequest } from "@runweave/shared/terminal/project";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import type { CreateTerminalSessionRequest, CreateTerminalSessionResponse, CreateTerminalEventsWsTicketResponse, CreateTerminalWsTicketResponse, TerminalSessionHistoryResponse, TerminalSessionListItem, TerminalSessionStatusResponse, UpdateTerminalSessionRequest } from "@runweave/shared/terminal/session";
import { requestJson, requestVoid } from "./http";

export {
  createTerminalQuickInput,
  deleteTerminalQuickInput,
  listTerminalQuickInputs,
  markTerminalQuickInputUsed,
  updateTerminalQuickInput,
} from "./terminal-quick-inputs";
export {
  completeAgentTeamRun,
  continueAgentTeamFrameworkRepair,
  decideAgentTeamFinding,
  focusAgentTeamPane,
  getAgentTeamFrameworkRepair,
  getAgentTeamRunForTerminal,
  proposeAgentTeamSplit,
  rerunAgentTeamFrameworkRepair,
  resumeAgentTeamRun,
  startAgentTeamRun,
  submitAgentTeamSplitGate,
} from "./terminal-agent-team";
export {
  deleteTerminalProjectPreviewFile,
  getTerminalProjectPreviewAsset,
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  listTerminalProjectPreviewDirectory,
  renameTerminalProjectPreviewFile,
  resetTerminalProjectPreviewChange,
  saveTerminalProjectPreviewFile,
  searchTerminalProjectPreviewContent,
  searchTerminalProjectPreviewFiles,
  searchTerminalProjectPreviewFolders,
} from "./terminal-preview";
export {
  createTerminalPrototypePreviewTicket,
  listTerminalPrototypeGallery,
} from "./terminal-prototype-gallery";

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
  void window.electronAPI?.checkAppServer?.().catch(() => {
    // Health prompts are advisory; terminal creation must continue.
  });

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

export async function listTerminalSessions(
  apiBase: string,
  token: string,
  signal?: AbortSignal,
): Promise<TerminalSessionListItem[]> {
  return requestJson<TerminalSessionListItem[]>(
    apiBase,
    "/api/terminal/session",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal,
    },
  );
}

export async function listTerminalPanels(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function createTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: CreateTerminalPanelRequest,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels`,
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

export async function prepareTerminalAgent(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: PrepareTerminalAgentRequest,
): Promise<PrepareTerminalAgentResponse> {
  return requestJson<PrepareTerminalAgentResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/agent/prepare`,
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

export async function recoverTerminalAgent(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: RecoverTerminalAgentRequest,
): Promise<RecoverTerminalAgentResponse> {
  return requestJson<RecoverTerminalAgentResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/agent/recover`,
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

export async function focusTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
  signal?: AbortSignal,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ focus: true }),
      signal,
    },
  );
}

export async function closeTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function resizeTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
  payload: ResizeTerminalPanelRequest,
): Promise<TerminalPanelWorkspace> {
  return requestJson<TerminalPanelWorkspace>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}/resize`,
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

export async function updateTerminalSession(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  payload: UpdateTerminalSessionRequest,
  signal?: AbortSignal,
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
      signal,
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

export async function getTerminalState(
  apiBase: string,
  token: string,
  terminalSessionId: string,
): Promise<TerminalStateResponse> {
  return requestJson<TerminalStateResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/state`,
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

export async function getTerminalPanelHistory(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
): Promise<TerminalSessionHistoryResponse> {
  return requestJson<TerminalSessionHistoryResponse>(
    apiBase,
    `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}/history`,
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
