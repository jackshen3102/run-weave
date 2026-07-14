import type { AgentTeamRun, AgentTeamRunsResponse, CompleteAgentTeamRunRequest, CreateAgentTeamRunRequest, ProposeAgentTeamSplitRequest, ResumeAgentTeamRunRequest, SubmitAgentTeamSplitGateRequest } from "@runweave/shared/agent-team";
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
