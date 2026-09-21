import type { OpenScheduledRunResponse, ScheduledRun, ScheduledTerminalBinding } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalSessionCreationOptions } from "../terminal/application/create-session";
import { createTerminalSession } from "../terminal/application/create-session";
import { prepareTerminalAgent } from "../terminal/application/agent-preparation";
import { readCodexThreadSnapshot } from "../terminal/runtime/codex-thread-snapshot";
import { buildPaneTarget } from "../terminal/application/panel-common";
import type { ScheduledTaskStore } from "./storage/store";
import { ScheduledTaskError } from "./errors";

const READY_TIMEOUT_MS = 90_000;

export class ScheduledTerminalAttachment {
  private readonly locks = new Map<string, Promise<OpenScheduledRunResponse>>();
  private readonly resumes = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
  ) {}

  open(run: ScheduledRun, replaceRepurposedBinding = false): Promise<OpenScheduledRunResponse> {
    const pending = this.locks.get(run.id);
    if (pending) return pending;
    const operation = this.openExclusive(run, replaceRepurposedBinding).finally(() => {
      this.locks.delete(run.id);
    });
    this.locks.set(run.id, operation);
    return operation;
  }

  private async openExclusive(run: ScheduledRun, replaceRepurposedBinding: boolean): Promise<OpenScheduledRunResponse> {
    if (["queued", "running", "stopping"].includes(run.status)) throw new ScheduledTaskError("thread_busy", 409, "The scheduled thread is still owned by its background run");
    if (!run.recoverable || !run.threadRef) throw new ScheduledTaskError("thread_unavailable", 409, "This run has no recoverable thread");
    const project = this.manager.getProject(run.executionProjectId);
    if (!project?.path || project.path !== run.cwd) throw new ScheduledTaskError("context_unavailable", 409, "The original project context is unavailable");

    const discovered = this.manager.listSessions().find((session) => session.source?.type === "scheduled-task" && session.source.runId === run.id);
    let session = run.terminalBinding ? this.manager.getSession(run.terminalBinding.terminalSessionId) : discovered;
    let panel = session
      ? (run.terminalBinding ? this.manager.getPanel(run.terminalBinding.panelId) : undefined) ?? this.manager.listPanels(session.id)[0]
      : undefined;

    if (session && panel) {
      const currentThread = panel.threadId ?? session.threadId;
      const currentProvider = panel.threadProvider ?? session.threadProvider;
      if (currentThread === run.threadRef.threadId && currentProvider === run.threadRef.provider) {
        return this.persistAndRespond(run, { terminalSessionId: session.id, panelId: panel.id, attachmentState: "ready" });
      }
      if (currentThread && (currentThread !== run.threadRef.threadId || currentProvider !== run.threadRef.provider)) {
        if (!replaceRepurposedBinding) throw new ScheduledTaskError("terminal_repurposed", 409, "The bound terminal now contains another conversation");
        session = undefined;
        panel = undefined;
      }
      if (
        session &&
        panel &&
        run.terminalBinding?.attachmentState === "starting"
      ) {
        this.startResume(run, session.id, panel.id);
        return response(run.executionProjectId, run.terminalBinding);
      }
    }

    if (!session || !panel) {
      session = await createTerminalSession(
        this.manager,
        { projectId: run.executionProjectId, runtimePreference: "tmux" },
        { ...this.options, strictDefaultPanel: true },
        { type: "scheduled-task", taskId: run.taskId, runId: run.id },
      );
      panel = this.manager.listPanels(session.id)[0];
      if (!panel) {
        await this.manager.destroySession(session.id);
        throw new ScheduledTaskError("thread_unavailable", 409, "The terminal has no resumable panel");
      }
    }

    const starting: ScheduledTerminalBinding = { terminalSessionId: session.id, panelId: panel.id, attachmentState: "starting" };
    await this.store.putBinding(run.id, starting);
    this.startResume(run, session.id, panel.id);
    return response(run.executionProjectId, starting);
  }

  private startResume(
    run: ScheduledRun,
    terminalSessionId: string,
    panelId: string,
  ): void {
    if (this.resumes.has(run.id)) return;
    const pending = this.resume(run, terminalSessionId, panelId).finally(() => {
      this.resumes.delete(run.id);
    });
    this.resumes.set(run.id, pending);
  }

  private async resume(run: ScheduledRun, terminalSessionId: string, panelId: string): Promise<void> {
    try {
      const session = this.manager.getSession(terminalSessionId);
      if (!session || !run.threadRef) throw new Error("terminal_or_thread_missing");
      if (run.threadRef.provider !== "codex") throw new Error("provider_attachment_unavailable");
      await prepareTerminalAgent(
        this.manager,
        session,
        this.options,
        { agent: "codex", prompt: "Resume scheduled task conversation", panelId, resumeThreadId: run.threadRef.threadId, cwd: run.cwd },
        { resetPanelBeforeResume: true, skipInitialPrompt: true },
      );
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const currentSession = this.manager.getSession(terminalSessionId);
        const currentPanel = this.manager.getPanel(panelId);
        const threadId = currentPanel?.threadId ?? currentSession?.threadId;
        const provider = currentPanel?.threadProvider ?? currentSession?.threadProvider;
        if (!threadId && run.threadRef.provider === "codex") {
          const snapshot = await readCodexThreadSnapshot(run.threadRef.threadId).catch(() => null);
          const tmuxService = this.options.tmuxService;
          const current = currentSession && currentPanel && tmuxService
            ? await tmuxService.readPaneMetadata(
                buildPaneTarget(currentSession, tmuxService, currentPanel),
              ).catch(() => null)
            : null;
          if (
            snapshot?.statusType &&
            snapshot.statusType !== "systemError" &&
            (current?.activeCommand === "codex" ||
              current?.paneCommand === "node")
          ) {
            await this.manager.updatePanelThreadId(
              panelId,
              run.threadRef.threadId,
              "codex",
            );
            if (snapshot.preview) {
              await this.manager.updatePanelPreview(panelId, snapshot.preview);
            }
            await this.store.putBinding(run.id, {
              terminalSessionId,
              panelId,
              attachmentState: "ready",
            });
            return;
          }
        }
        if (threadId === run.threadRef.threadId && provider === run.threadRef.provider && currentPanel?.terminalState?.state !== "agent_starting") {
          await this.store.putBinding(run.id, { terminalSessionId, panelId, attachmentState: "ready" });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("terminal_attachment_timeout");
    } catch (error) {
      await this.store.putBinding(run.id, { terminalSessionId, panelId, attachmentState: "failed", error: error instanceof Error ? error.message : "terminal_attachment_failed" });
    }
  }

  private async persistAndRespond(run: ScheduledRun, binding: ScheduledTerminalBinding): Promise<OpenScheduledRunResponse> {
    await this.store.putBinding(run.id, binding);
    return response(run.executionProjectId, binding);
  }
}

function response(projectId: string, binding: ScheduledTerminalBinding): OpenScheduledRunResponse {
  return { ...binding, projectId, terminalUrl: `/terminal/${encodeURIComponent(binding.terminalSessionId)}` };
}
