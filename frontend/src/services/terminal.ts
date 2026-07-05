import type {
  AgentTeamRun,
  AgentTeamRunsResponse,
  CompleteAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
  CreateTerminalProjectRequest,
  CreateTerminalClipboardImageRequest,
  CreateTerminalClipboardImageResponse,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalPanelRequest,
  CreateTerminalEventsWsTicketResponse,
  CreateTerminalWsTicketResponse,
  ProposeAgentTeamSplitRequest,
  RecordAgentTeamRoundRequest,
  ResizeTerminalPanelRequest,
  ResumeAgentTeamRunRequest,
  SubmitAgentTeamSplitGateRequest,
  SendTerminalInputRequest,
  SendTerminalInputResponse,
  TerminalCompletionEventListResponse,
  TerminalPanelWorkspace,
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  UpdateTerminalProjectRequest,
  UpdateTerminalSessionRequest,
} from "@runweave/shared";
import { requestJson, requestVoid } from "./http";

export {
  createTerminalQuickInput,
  deleteTerminalQuickInput,
  listTerminalQuickInputs,
  markTerminalQuickInputUsed,
  updateTerminalQuickInput,
} from "./terminal-quick-inputs";
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

export async function focusTerminalPanel(
  apiBase: string,
  token: string,
  terminalSessionId: string,
  panelId: string,
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

const AGENT_TEAM_JSON_HEADERS = (token: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
});

export async function getAgentTeamRunForTerminal(
  apiBase: string,
  token: string,
  projectId: string,
  terminalSessionId: string,
): Promise<AgentTeamRun | null> {
  const response = await requestJson<AgentTeamRunsResponse>(
    apiBase,
    `/api/agent-team/runs?projectId=${encodeURIComponent(projectId)}&terminalSessionId=${encodeURIComponent(terminalSessionId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.runs[0] ?? null;
}

export async function startAgentTeamRun(
  apiBase: string,
  token: string,
  payload: CreateAgentTeamRunRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(apiBase, "/api/agent-team/runs", {
    method: "POST",
    headers: AGENT_TEAM_JSON_HEADERS(token),
    body: JSON.stringify(payload),
  });
}

export async function proposeAgentTeamSplit(
  apiBase: string,
  token: string,
  runId: string,
  payload: ProposeAgentTeamSplitRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/propose-split`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify(payload),
    },
  );
}

export async function submitAgentTeamSplitGate(
  apiBase: string,
  token: string,
  runId: string,
  payload: SubmitAgentTeamSplitGateRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/split-gate`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify(payload),
    },
  );
}

export async function recordAgentTeamRound(
  apiBase: string,
  token: string,
  runId: string,
  payload: RecordAgentTeamRoundRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/round`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify(payload),
    },
  );
}

export async function resumeAgentTeamRun(
  apiBase: string,
  token: string,
  runId: string,
  payload: ResumeAgentTeamRunRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/resume`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify(payload),
    },
  );
}

export async function completeAgentTeamRun(
  apiBase: string,
  token: string,
  runId: string,
  payload: CompleteAgentTeamRunRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/complete`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify(payload),
    },
  );
}

export async function focusAgentTeamPane(
  apiBase: string,
  token: string,
  runId: string,
  panelId: string,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/focus-pane`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify({ panelId }),
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
