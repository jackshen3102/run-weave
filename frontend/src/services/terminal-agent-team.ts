import type {
  AgentTeamFrameworkRepairRecoveryStatus,
  AgentTeamFrameworkRepairResponse,
  AgentTeamRun,
  AgentTeamRunsResponse,
  CompleteAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
  DecideAgentTeamAcceptanceRequest,
  DecideAgentTeamFindingRequest,
  ProposeAgentTeamSplitRequest,
  ResumeAgentTeamRunRequest,
  SubmitAgentTeamSplitGateRequest,
} from "@runweave/shared/agent-team";
import { requestJson } from "./http";

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

export async function getAgentTeamFrameworkRepair(
  apiBase: string,
  token: string,
  runId: string,
): Promise<AgentTeamFrameworkRepairRecoveryStatus> {
  return requestJson<AgentTeamFrameworkRepairRecoveryStatus>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/framework-repair`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function continueAgentTeamFrameworkRepair(
  apiBase: string,
  token: string,
  runId: string,
): Promise<AgentTeamFrameworkRepairResponse> {
  return requestFrameworkRepairAction(apiBase, token, runId, "continue");
}

export async function rerunAgentTeamFrameworkRepair(
  apiBase: string,
  token: string,
  runId: string,
): Promise<AgentTeamFrameworkRepairResponse> {
  return requestFrameworkRepairAction(apiBase, token, runId, "rerun");
}

function requestFrameworkRepairAction(
  apiBase: string,
  token: string,
  runId: string,
  action: "continue" | "rerun",
): Promise<AgentTeamFrameworkRepairResponse> {
  return requestJson<AgentTeamFrameworkRepairResponse>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/framework-repair/${action}`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: "{}",
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

export async function decideAgentTeamFinding(
  apiBase: string,
  token: string,
  runId: string,
  payload: DecideAgentTeamFindingRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/finding-disposition`,
    {
      method: "POST",
      headers: AGENT_TEAM_JSON_HEADERS(token),
      body: JSON.stringify(payload),
    },
  );
}

export async function decideAgentTeamAcceptance(
  apiBase: string,
  token: string,
  runId: string,
  payload: DecideAgentTeamAcceptanceRequest,
): Promise<AgentTeamRun> {
  return requestJson<AgentTeamRun>(
    apiBase,
    `/api/agent-team/runs/${encodeURIComponent(runId)}/acceptance-disposition`,
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
