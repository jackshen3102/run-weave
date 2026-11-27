import type { CreateTerminalClipboardFileRequest, CreateTerminalClipboardFileResponse } from "@runweave/shared/terminal/input";
import type { TerminalStateResponse } from "@runweave/shared/terminal/events";
import type { PrepareTerminalAgentRequest, PrepareTerminalAgentResponse } from "@runweave/shared/terminal/agent-preparation";
import type { SendTerminalInterruptRequest, SendTerminalInterruptResponse, SendTerminalInputRequest, SendTerminalInputResponse } from "@runweave/shared/terminal/input";
import type { CreateTerminalPanelRequest, TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { CreateTerminalProjectRequest, TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { CreateTerminalSessionRequest, CreateTerminalSessionResponse, TerminalSessionHistoryResponse, TerminalSessionListItem, TerminalSessionStatusResponse } from "@runweave/shared/terminal/session";
import type {
  TerminalSendAndWaitRequest,
  TerminalSendAndWaitResponse,
  TerminalSnapshotResponse,
  TerminalWaitOutputRequest,
  TerminalWaitOutputResponse,
} from "@runweave/shared/terminal/wait";
import type { AuthContext } from "./auth-context.js";
import type { CodeReviewDetail, CodeReviewPage, CodeReviewRun, CreateCodeReviewRequest } from "@runweave/shared/terminal/code-review";
import type { CreateTerminalTaskRequest, StartTerminalTaskRequest, SendTerminalTaskRequest, ControlTerminalTaskRequest, ReviewTerminalTaskRequest, InterruptTerminalTaskRequest, TerminalTask, TerminalTaskObservation } from "@runweave/shared/terminal/task";

export class TerminalHttpClient {
  constructor(private readonly auth: AuthContext) {}

  createCodeReview(terminalId: string, payload: CreateCodeReviewRequest): Promise<CodeReviewRun> {
    return this.auth.requestJson(`/api/terminal/session/${encodeURIComponent(terminalId)}/code-reviews`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
  }
  listCodeReviews(terminalId: string, before?: string): Promise<CodeReviewPage> {
    return this.auth.requestJson(`/api/terminal/session/${encodeURIComponent(terminalId)}/code-reviews${before ? `?before=${encodeURIComponent(before)}` : ""}`);
  }
  getCodeReview(reviewId: string): Promise<CodeReviewDetail> {
    return this.auth.requestJson(`/api/terminal/code-reviews/${encodeURIComponent(reviewId)}`);
  }

  listTasks(): Promise<{ tasks: TerminalTask[] }> { return this.auth.requestJson("/api/terminal/tasks"); }
  createTask(payload: CreateTerminalTaskRequest): Promise<TerminalTask> { return this.taskRequest("", payload); }
  observeTask(id: string, afterTurnId?: string): Promise<TerminalTaskObservation> {
    return this.auth.requestJson(`/api/terminal/tasks/${encodeURIComponent(id)}${afterTurnId ? `?afterTurnId=${encodeURIComponent(afterTurnId)}` : ""}`);
  }
  startTask(id: string, payload: StartTerminalTaskRequest): Promise<TerminalTask> { return this.taskRequest(`/${encodeURIComponent(id)}/start`, payload); }
  sendTask(id: string, payload: SendTerminalTaskRequest): Promise<TerminalTaskObservation> { return this.taskRequest(`/${encodeURIComponent(id)}/send`, payload); }
  controlTask(id: string, payload: ControlTerminalTaskRequest): Promise<TerminalTaskObservation> { return this.taskRequest(`/${encodeURIComponent(id)}/control`, payload); }
  reviewTask(id: string, payload: ReviewTerminalTaskRequest): Promise<TerminalTaskObservation> { return this.taskRequest(`/${encodeURIComponent(id)}/review`, payload); }
  interruptTask(id: string, payload: InterruptTerminalTaskRequest): Promise<TerminalTaskObservation> { return this.taskRequest(`/${encodeURIComponent(id)}/interrupt`, payload); }
  private taskRequest<T>(suffix: string, payload: unknown): Promise<T> {
    return this.auth.requestJson(`/api/terminal/tasks${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }

  withSignal(signal: AbortSignal): TerminalHttpClient {
    return new TerminalHttpClient({
      ...this.auth,
      requestJson: <T>(apiPath: string, init?: RequestInit) =>
        this.auth.requestJson<T>(apiPath, { ...init, signal }),
      requestVoid: (apiPath: string, init?: RequestInit) =>
        this.auth.requestVoid(apiPath, { ...init, signal }),
    });
  }

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
    options?: { explain?: boolean },
  ): Promise<TerminalStateResponse> {
    const query = options?.explain ? "?explain=1" : "";
    return this.auth.requestJson<TerminalStateResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/state${query}`,
    );
  }

  getSessionSnapshot(
    terminalSessionId: string,
    options?: {
      panelId?: string;
      panelAlias?: string;
      role?: string;
      lines?: number;
      unwrap?: boolean;
    },
  ): Promise<TerminalSnapshotResponse> {
    const params = new URLSearchParams();
    if (options?.panelId) params.set("panelId", options.panelId);
    if (options?.panelAlias) params.set("panelAlias", options.panelAlias);
    if (options?.role) params.set("role", options.role);
    if (options?.lines !== undefined) params.set("lines", String(options.lines));
    if (options?.unwrap !== undefined) {
      params.set("unwrap", options.unwrap ? "1" : "0");
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.auth.requestJson<TerminalSnapshotResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/snapshot${suffix}`,
    );
  }

  sendAndWait(
    terminalSessionId: string,
    payload: TerminalSendAndWaitRequest,
  ): Promise<TerminalSendAndWaitResponse> {
    return this.auth.requestJson<TerminalSendAndWaitResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/send-and-wait`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  waitOutput(
    terminalSessionId: string,
    payload: TerminalWaitOutputRequest,
  ): Promise<TerminalWaitOutputResponse> {
    return this.auth.requestJson<TerminalWaitOutputResponse>(
      `/api/terminal/session/${encodeURIComponent(terminalSessionId)}/wait-output`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  createClipboardFile(id: string, payload: CreateTerminalClipboardFileRequest): Promise<CreateTerminalClipboardFileResponse> {
    return this.auth.requestJson(`/api/terminal/session/${encodeURIComponent(id)}/clipboard-file`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
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
