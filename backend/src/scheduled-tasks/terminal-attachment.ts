import { codexScheduledArgs } from "./providers/codex-options";
import { validateExecutionContext } from "./execution-context";
import { settingText } from "@runweave/config-node";
import type {
  OpenScheduledRunResponse,
  ScheduledRun,
  ScheduledTerminalBinding,
} from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalSessionCreationOptions } from "../terminal/application/create-session";
import { createTerminalSession } from "../terminal/application/create-session";
import { prepareTerminalAgent } from "../terminal/application/agent-preparation";
import { isStalePendingAgentPrepare } from "../terminal/application/panel-metadata";
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
    // Atomically cancel the pending continuation before releasing this thread to a terminal.
    if (run.continuation?.nextAt && ["waiting", "queued"].includes(run.status))
      run = await this.store.requestRunStop(run.id, new Date().toISOString());
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
    await validateExecutionContext(run, this.manager);

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
          pane?.cwd === run.executionContext.cwd! &&
          (pane.activeCommand === "codex" || pane.paneCommand === "node" || pane.paneCommand === "codex")
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
        return response(session.projectId, knownBinding);
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
        return response(session.projectId, starting);
      }
    }

    // Reject missing history before allocating any terminal resources.
    await checkpointCodexResume(run.threadRef.threadId, run.executionContext.cwd!);
    if (!session || !panel) {
      session = await createTerminalSession(
        this.manager,
        { ...(run.snapshot.origin?.kind === "quick-input" && run.executionContext.kind === "project" ? { projectId: run.executionContext.projectId } : {}), cwd: run.executionContext.cwd!, runtimePreference: "tmux" },
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
    return response(session.projectId, starting);
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
        run.executionContext.cwd!,
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
      if (!tmuxService) throw new Error("terminal_tmux_unavailable");
      const panel = this.manager.getPanel(panelId);
      if (!panel) throw new Error("terminal_panel_missing");
      const target = {
        ...resolveTmuxTarget(session, tmuxService),
        paneId: panel.tmuxPaneId,
      };
      const pane = (await tmuxService.listPanes(target)).find(
        (item) => item.paneId === panel.tmuxPaneId,
      );
      // A timeout does not stop the TUI. Reconfirm the original launch instead
      // of preparing another agent (which also discards its operation identity).
      let operationId =
        pane?.agentPrepareCommand === "codex" &&
        pane.agentPrepareExit?.startsWith("pending:") &&
        !isStalePendingAgentPrepare(pane)
          ? pane.agentPrepareExit.slice("pending:".length)
          : null;
      if (operationId) {
        const generation = this.manager.getPanelAgentOperationGeneration(
          session.id,
          panelId,
        );
        if (
          generation &&
          (generation.operationId !== operationId ||
            generation.provider !== "codex")
        )
          throw new Error("terminal_attachment_changed");
        if (!generation) {
          if (
            !(await this.manager.beginPanelAgentPreparation(
              session.id,
              panelId,
              operationId,
              "codex",
            ))
          )
            throw new Error("terminal_attachment_changed");
          this.manager.releasePanelAgentPreparation(
            session.id,
            panelId,
            operationId,
          );
        }
      } else {
        const preparation = await prepareTerminalAgent(
          this.manager,
          session,
          this.options,
          {
            agent: "codex",
            command: settingText("agents.codex.binary") ?? "codex",
            prompt: "Resume scheduled task conversation",
            panelId,
            resumeThreadId: run.threadRef.threadId,
            args: [
              ...codexScheduledArgs(run.snapshot),
              "-c",
              'tui.resume_cwd="current"',
            ],
            cwd: run.executionContext.cwd!,
          },
          {
            resetPanelBeforeResume: true,
            skipInitialPrompt: true,
            stageResumeCommand: true,
          },
        );
        operationId = preparation.operationId;
      }
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const currentSession = this.manager.getSession(terminalSessionId);
        const currentPanel = this.manager.getPanel(panelId);
        const current =
          currentSession && currentPanel
            ? await tmuxService
                .listPanes(resolveTmuxTarget(currentSession, tmuxService))
                .then((panes) =>
                  panes.find((pane) => pane.paneId === currentPanel.tmuxPaneId),
                )
                .catch(() => null)
            : null;
        const exitPrefix = `exit:${operationId}:`;
        if (
          current?.agentPrepareExit?.startsWith(exitPrefix) &&
          this.manager.matchesPanelAgentOperationGeneration(
            terminalSessionId,
            panelId,
            operationId,
            "codex",
          )
        ) {
          await this.manager.updatePanelTerminalState(
            panelId,
            { state: "shell_idle", agent: null },
            operationId,
          );
          throw new Error(
            `terminal_agent_exit:${current.agentPrepareExit.slice(exitPrefix.length)}`,
          );
        }
        let confirmedState: "agent_idle" | "agent_running" | null = null;
        // A staged shell launch can retain "." as its command hint; the foreground native Codex still requires exact resume proof below.
        if (
          currentSession &&
          currentPanel &&
          current?.cwd === run.executionContext.cwd! &&
          (current?.activeCommand === "codex" ||
            current?.paneCommand === "node" ||
            current?.paneCommand === "codex") &&
          this.manager.matchesPanelAgentOperationGeneration(
            terminalSessionId,
            panelId,
            operationId,
            "codex",
          ) &&
          (confirmedState = await confirmCodexResume(
            checkpoint,
            run.threadRef.threadId,
            run.executionContext.cwd!,
            run.snapshot,
            {
              panePid: (
                await tmuxService.textAttachmentProcessIdentity({
                  ...resolveTmuxTarget(currentSession, tmuxService),
                  paneId: currentPanel.tmuxPaneId,
                })
              ).panePid,
              panel: currentPanel,
              operationId,
            },
          ))
        ) {
          const latestPanel = this.manager.getPanel(panelId);
          if (
            this.manager.getSession(terminalSessionId)?.status !== "running" ||
            latestPanel?.status !== "running" ||
            latestPanel.tmuxPaneId !== currentPanel.tmuxPaneId ||
            !this.manager.matchesPanelAgentOperationGeneration(
              terminalSessionId,
              panelId,
              operationId,
              "codex",
            ) ||
            (latestPanel.threadId &&
              (latestPanel.threadId !== run.threadRef.threadId ||
                latestPanel.threadProvider !== "codex"))
          )
            throw new Error("terminal_attachment_changed");
          await this.manager.updatePanelThreadId(
            panelId,
            run.threadRef.threadId,
            "codex",
            operationId,
          );
          // Only complete startup; hooks may already have advanced the state.
          const state = this.manager.getPanel(panelId)?.terminalState?.state;
          if (state === "agent_starting" || state === "shell_idle") {
            await this.manager.updatePanelTerminalState(
              panelId,
              { state: confirmedState, agent: "codex" },
              operationId,
            );
          }
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
    return response(this.manager.getSession(binding.terminalSessionId)!.projectId, binding);
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
