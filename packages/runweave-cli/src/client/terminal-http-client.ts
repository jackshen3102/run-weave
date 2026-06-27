import type {
  CreateTerminalProjectRequest,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalPanelRequest,
  SendTerminalInterruptRequest,
  SendTerminalInterruptResponse,
  SendTerminalInputRequest,
  SendTerminalInputResponse,
  TerminalPanelWorkspace,
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  TerminalStateResponse,
} from "@runweave/shared";
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
}
