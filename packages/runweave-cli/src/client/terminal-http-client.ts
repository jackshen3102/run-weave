import type {
  CreateTerminalProjectRequest,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  SendTerminalInterruptRequest,
  SendTerminalInterruptResponse,
  SendTerminalInputRequest,
  SendTerminalInputResponse,
  TerminalProjectListItem,
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
}
