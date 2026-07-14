import type { AgentTeamExportHistoryMode, AgentTeamExportResponse, AgentTeamRunsResponse } from "@runweave/shared/agent-team";
import type { TerminalStateResponse } from "@runweave/shared/terminal/events";
import type { PrepareTerminalAgentRequest, PrepareTerminalAgentResponse } from "@runweave/shared/terminal/agent-preparation";
import type { SendTerminalInterruptRequest, SendTerminalInterruptResponse, SendTerminalInputRequest, SendTerminalInputResponse } from "@runweave/shared/terminal/input";
import type { CreateTerminalPanelRequest, TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { CreateTerminalProjectRequest, TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { CreateTerminalSessionRequest, CreateTerminalSessionResponse, TerminalSessionHistoryResponse, TerminalSessionListItem, TerminalSessionStatusResponse } from "@runweave/shared/terminal/session";
import type { AuthContext } from "./auth-context.js";

export class TerminalHttpClient {
  constructor(private readonly auth: AuthContext) {}

  listProjects(): Promise<TerminalProjectListItem[]> {
    return this.auth.requestJson<TerminalProjectListItem[]>(
      "/api/terminal/project",
    );
  }

  createProject(
    payload: CreateTerminalProjectRequest,
  ): Promise<TerminalProjectListItem> {
    return this.auth.requestJson<TerminalProjectListItem>(
      "/api/terminal/project",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.auth.requestVoid(
      `/api/terminal/project/${encodeURIComponent(projectId)}`,
      {
        method: "DELETE",
      },
    );
  }

  listSessions(): Promise<TerminalSessionListItem[]> {
    return this.auth.requestJson<TerminalSessionListItem[]>(
      "/api/terminal/session",
    );
  }

  createSession(
    payload: CreateTerminalSessionRequest,
  ): Promise<CreateTerminalSessionResponse> {
    return this.auth.requestJson<CreateTerminalSessionResponse>(
      "/api/terminal/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  getSession(
    terminalSessionId: string,
  ): Promise<TerminalSessionStatusResponse> {
    return this.auth.requestJson<TerminalSessionStatusResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    );
  }

  getSessionHistory(
    terminalSessionId: string,
  ): Promise<TerminalSessionHistoryResponse> {
    return this.auth.requestJson<TerminalSessionHistoryResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/history`,
    );
  }

  listPanels(terminalSessionId: string): Promise<TerminalPanelWorkspace> {
    return this.auth.requestJson<TerminalPanelWorkspace>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels`,
    );
  }

  createPanel(
    terminalSessionId: string,
    payload: CreateTerminalPanelRequest,
  ): Promise<TerminalPanelWorkspace> {
    return this.auth.requestJson<TerminalPanelWorkspace>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  prepareAgent(
    terminalSessionId: string,
    payload: PrepareTerminalAgentRequest,
  ): Promise<PrepareTerminalAgentResponse> {
    return this.auth.requestJson<PrepareTerminalAgentResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/agent/prepare`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  focusPanel(
    terminalSessionId: string,
    panelId: string,
  ): Promise<TerminalPanelWorkspace> {
    return this.auth.requestJson<TerminalPanelWorkspace>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focus: true }),
      },
    );
  }

  async closePanel(
    terminalSessionId: string,
    panelId: string,
  ): Promise<TerminalPanelWorkspace> {
    return this.auth.requestJson<TerminalPanelWorkspace>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}`,
      {
        method: "DELETE",
      },
    );
  }

  getPanelHistory(
    terminalSessionId: string,
    panelId: string,
  ): Promise<TerminalSessionHistoryResponse> {
    return this.auth.requestJson<TerminalSessionHistoryResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/panels/${encodeURIComponent(panelId)}/history`,
    );
  }

  getCurrentTerminalState(
    terminalSessionId: string,
  ): Promise<TerminalStateResponse> {
    return this.auth.requestJson<TerminalStateResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/state`,
    );
  }

  sendInput(
    terminalSessionId: string,
    payload: SendTerminalInputRequest,
  ): Promise<SendTerminalInputResponse> {
    return this.auth.requestJson<SendTerminalInputResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/input`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  interruptSession(
    terminalSessionId: string,
    payload: SendTerminalInterruptRequest = {},
  ): Promise<SendTerminalInterruptResponse> {
    return this.auth.requestJson<SendTerminalInterruptResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/interrupt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  async deleteSession(terminalSessionId: string): Promise<void> {
    await this.auth.requestVoid(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
      {
        method: "DELETE",
      },
    );
  }

  listAgentTeamRuns(
    projectId: string,
    terminalSessionId?: string,
  ): Promise<AgentTeamRunsResponse> {
    const query = new URLSearchParams({ projectId });
    if (terminalSessionId) {
      query.set("terminalSessionId", terminalSessionId);
    }
    return this.auth.requestJson<AgentTeamRunsResponse>(
      `/api/agent-team/runs?${query.toString()}`,
    );
  }

  exportAgentTeamRun(
    runId: string,
    options: {
      history?: AgentTeamExportHistoryMode;
      tail?: number;
      includeSessionOther?: boolean;
      includeOutboxes?: boolean;
    } = {},
  ): Promise<AgentTeamExportResponse> {
    const query = new URLSearchParams();
    if (options.history) {
      query.set("history", options.history);
    }
    if (options.tail !== undefined) {
      query.set("tail", String(options.tail));
    }
    if (options.includeSessionOther !== undefined) {
      query.set("includeSessionOther", String(options.includeSessionOther));
    }
    if (options.includeOutboxes !== undefined) {
      query.set("includeOutboxes", String(options.includeOutboxes));
    }
    const queryText = query.toString();
    const suffix = queryText ? `?${queryText}` : "";
    return this.auth.requestJson<AgentTeamExportResponse>(
      `/api/agent-team/runs/${encodeURIComponent(runId)}/export${suffix}`,
    );
  }
}
