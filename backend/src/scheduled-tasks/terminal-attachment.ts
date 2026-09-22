import { codexScheduledArgs } from "./providers/codex-options";
import { stat } from "node:fs/promises";
import type {
  OpenScheduledRunResponse,
  ScheduledRun,
  ScheduledTerminalBinding,
} from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalSessionCreationOptions } from "../terminal/application/create-session";
import { createTerminalSession } from "../terminal/application/create-session";
import { prepareTerminalAgent } from "../terminal/application/agent-preparation";
import {
  ensureTerminalRuntime,
  resolveTmuxTarget,
} from "../terminal/runtime/launcher";
import type { ScheduledTaskStore } from "./storage/store";
import { ScheduledTaskError } from "./errors";
import {
  checkpointCodexResume,
  confirmCodexResume,
} from "./providers/codex-resume";

const READY_TIMEOUT_MS = 90_000;

export class ScheduledTerminalAttachment {
  private readonly locks = new Map<string, Promise<OpenScheduledRunResponse>>();
  private readonly resumes = new Map<string, Promise<void>>();
  private readonly bindings = new Map<string, ScheduledTerminalBinding>();

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
  ) {}

  open(
    run: ScheduledRun,
    replaceRepurposedBinding = false,
  ): Promise<OpenScheduledRunResponse> {
    const pending = this.locks.get(run.id);
    if (pending) return pending;
    const operation = this.openExclusive(run, replaceRepurposedBinding).finally(
      () => {
        this.locks.delete(run.id);
      },
    );
    this.locks.set(run.id, operation);
    return operation;
  }

  private async openExclusive(
    run: ScheduledRun,
    replaceRepurposedBinding: boolean,
  ): Promise<OpenScheduledRunResponse> {
    if (["queued", "running", "stopping"].includes(run.status))
      throw new ScheduledTaskError(
        "thread_busy",
        409,
        "The scheduled thread is still owned by its background run",
      );
    if (run.status === "waiting" && run.error?.code === "owner_unresolved") {
      throw new ScheduledTaskError(
        "thread_busy",
        409,
        "The previous execution process is still alive",
      );
    }
    if (!run.recoverable || !run.threadRef)
      throw new ScheduledTaskError(
        "thread_unavailable",
        409,
        "This run has no recoverable thread",
      );
    const project = this.manager.getProject(run.executionProjectId);
    if (
      !project?.path ||
      project.path !== run.cwd ||
      !(await stat(run.cwd).then(
        (value) => value.isDirectory(),
        () => false,
      ))
    )
      throw new ScheduledTaskError(
        "context_unavailable",
        409,
        "The original project context is unavailable",
      );

    const discovered = this.manager
      .listSessions()
      .find(
        (session) =>
          session.source?.type === "scheduled-task" &&
          session.source.runId === run.id,
      );
    const knownBinding = this.bindings.get(run.id) ?? run.terminalBinding;
    let session = knownBinding
      ? (this.manager.getSession(knownBinding.terminalSessionId) ?? discovered)
      : discovered;
    let panel = session
      ? ((knownBinding
          ? this.manager.getPanel(knownBinding.panelId)
          : undefined) ?? this.manager.listPanels(session.id)[0])
      : undefined;

    if (session && panel) {
      // Completed turns may move their identity into lastThreadId. That identity
      // still owns the conversation and its unsent draft in this panel.
      const threadOwner =
        panel.threadId || panel.lastThreadId ? panel : session;
      const currentThread = threadOwner.threadId ?? threadOwner.lastThreadId;
      const currentProvider = threadOwner.threadId
        ? threadOwner.threadProvider
        : threadOwner.lastThreadProvider;
      if (
        knownBinding?.attachmentState === "ready" &&
        currentThread === run.threadRef.threadId &&
        currentProvider === run.threadRef.provider &&
        this.options.tmuxService &&
        (await this.options.tmuxService.hasSession(
          resolveTmuxTarget(session, this.options.tmuxService),
        ))
      ) {
        const panes = await this.options.tmuxService.listPanes(
          resolveTmuxTarget(session, this.options.tmuxService),
        );
        const paneId = panel.tmuxPaneId;
        const pane = panes.find((item) => item.paneId === paneId);
        if (
          pane?.cwd === run.cwd &&
          (pane.activeCommand === "codex" || pane.paneCommand === "node")
        ) {
          return this.persistAndRespond(run, {
            terminalSessionId: session.id,
            panelId: panel.id,
            attachmentState: "ready",
          });
        }
      }
      if (
        currentThread &&
        (currentThread !== run.threadRef.threadId ||
          currentProvider !== run.threadRef.provider)
      ) {
        if (!replaceRepurposedBinding)
          throw new ScheduledTaskError(
            "terminal_repurposed",
            409,
            "The bound terminal now contains another conversation",
          );
        session = undefined;
        panel = undefined;
      }
      if (session && panel && knownBinding?.attachmentState === "starting") {
        this.startResume(run, session.id, panel.id);
        return response(run.executionProjectId, knownBinding);
      }
      if (session && panel && knownBinding?.attachmentState === "failed") {
        const starting: ScheduledTerminalBinding = {
          terminalSessionId: session.id,
          panelId: panel.id,
          attachmentState: "starting",
        };
        await this.store.putBinding(run.id, starting);
        this.bindings.set(run.id, starting);
        this.startResume(run, session.id, panel.id);
        return response(run.executionProjectId, starting);
      }
    }

    // Reject missing history before allocating any terminal resources.
    await checkpointCodexResume(run.threadRef.threadId, run.cwd);
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
        throw new ScheduledTaskError(
          "thread_unavailable",
          409,
          "The terminal has no resumable panel",
        );
      }
    }

    const starting: ScheduledTerminalBinding = {
      terminalSessionId: session.id,
      panelId: panel.id,
      attachmentState: "starting",
    };
    await this.store.putBinding(run.id, starting);
    this.bindings.set(run.id, starting);
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

  private async resume(
    run: ScheduledRun,
    terminalSessionId: string,
    panelId: string,
  ): Promise<void> {
    try {
      const session = this.manager.getSession(terminalSessionId);
      if (!session || !run.threadRef)
        throw new Error("terminal_or_thread_missing");
      if (run.threadRef.provider !== "codex")
        throw new Error("provider_attachment_unavailable");
      const checkpoint = await checkpointCodexResume(
        run.threadRef.threadId,
        run.cwd,
      );
      const { tmuxService, runtimeRegistry, ptyService } = this.options;
      if (
        tmuxService &&
        runtimeRegistry &&
        ptyService &&
        !(await tmuxService.hasSession(resolveTmuxTarget(session, tmuxService)))
      ) {
        await ensureTerminalRuntime({
          session,
          terminalSessionManager: this.manager,
          runtimeRegistry,
          ptyService,
          tmuxService,
          tmuxOutputWatcher: this.options.tmuxOutputWatcher,
          // This attachment owns the exact resume below; avoid a second resume.
          allowMissingTmuxSession: true,
        });
        const [pane] = await tmuxService.listPanes(
          resolveTmuxTarget(session, tmuxService),
        );
        const panel = this.manager.getPanel(panelId);
        if (!pane || !panel) throw new Error("terminal_panel_missing");
        await this.manager.updateSessionThreadId(session.id, null);
        await this.manager.upsertPanel({
          ...panel,
          tmuxPaneId: pane.paneId,
          status: "running",
          threadId: undefined,
          threadProvider: undefined,
          activeCommand: null,
          terminalState: { state: "shell_idle", agent: null },
        });
        this.manager.markRunning(session.id);
      }
      const preparation = await prepareTerminalAgent(
        this.manager,
        session,
        this.options,
        {
          agent: "codex",
          prompt: "Resume scheduled task conversation",
          panelId,
          resumeThreadId: run.threadRef.threadId,
          args: codexScheduledArgs(run.snapshot),
          cwd: run.cwd,
        },
        { resetPanelBeforeResume: true, skipInitialPrompt: true },
      );
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const currentSession = this.manager.getSession(terminalSessionId);
        const currentPanel = this.manager.getPanel(panelId);
        const tmuxService = this.options.tmuxService;
        const current =
          currentSession && currentPanel && tmuxService
            ? await tmuxService
                .listPanes(resolveTmuxTarget(currentSession, tmuxService))
                .then((panes) =>
                  panes.find((pane) => pane.paneId === currentPanel.tmuxPaneId),
                )
                .catch(() => null)
            : null;
        const exitPrefix = `exit:${preparation.operationId}:`;
        if (
          current?.agentPrepareExit?.startsWith(exitPrefix) &&
          this.manager.matchesPanelAgentOperationGeneration(
            terminalSessionId,
            panelId,
            preparation.operationId,
            "codex",
          )
        ) {
          await this.manager.updatePanelTerminalState(
            panelId,
            { state: "shell_idle", agent: null },
            preparation.operationId,
          );
          throw new Error(
            `terminal_agent_exit:${current.agentPrepareExit.slice(exitPrefix.length)}`,
          );
        }
        if (
          current?.cwd === run.cwd &&
          (current?.activeCommand === "codex" ||
            current?.paneCommand === "node") &&
          this.manager.matchesPanelAgentOperationGeneration(
            terminalSessionId,
            panelId,
            preparation.operationId,
            "codex",
          ) &&
          (await confirmCodexResume(
            checkpoint,
            run.threadRef.threadId,
            run.cwd,
            run.snapshot,
          ))
        ) {
          await this.manager.updatePanelThreadId(
            panelId,
            run.threadRef.threadId,
            "codex",
            preparation.operationId,
          );
          await this.manager.updatePanelTerminalState(
            panelId,
            { state: "agent_idle", agent: "codex" },
            preparation.operationId,
          );
          await this.store.putBinding(run.id, {
            terminalSessionId,
            panelId,
            attachmentState: "ready",
          });
          this.bindings.set(run.id, {
            terminalSessionId,
            panelId,
            attachmentState: "ready",
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("terminal_attachment_timeout");
    } catch (error) {
      await this.store.putBinding(run.id, {
        terminalSessionId,
        panelId,
        attachmentState: "failed",
        error:
          error instanceof Error ? error.message : "terminal_attachment_failed",
      });
      this.bindings.set(run.id, {
        terminalSessionId,
        panelId,
        attachmentState: "failed",
        error:
          error instanceof Error ? error.message : "terminal_attachment_failed",
      });
    }
  }

  private async persistAndRespond(
    run: ScheduledRun,
    binding: ScheduledTerminalBinding,
  ): Promise<OpenScheduledRunResponse> {
    await this.store.putBinding(run.id, binding);
    this.bindings.set(run.id, binding);
    return response(run.executionProjectId, binding);
  }
}

function response(
  projectId: string,
  binding: ScheduledTerminalBinding,
): OpenScheduledRunResponse {
  return {
    ...binding,
    projectId,
    terminalUrl: `/terminal/${encodeURIComponent(binding.terminalSessionId)}`,
  };
}
