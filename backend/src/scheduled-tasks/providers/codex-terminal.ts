import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { settingText } from "@runweave/config-node";
import { createTerminalSession, type TerminalSessionCreationOptions } from "../../terminal/application/create-session";
import { deleteTerminalSession } from "../../terminal/application/delete-session";
import { prepareTerminalAgent } from "../../terminal/application/agent-preparation";
import { sendInputToSession } from "../../terminal/application/input-dispatcher";
import { resolveConversationTarget } from "../../terminal/application/conversation";
import { buildPaneTarget } from "../../terminal/application/panel-common";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { observeTerminalInput } from "../../terminal/runtime/input-admission";
import { recordTerminalSessionDeleted } from "../../terminal/runtime/activity-events";
import { AppServerHistoryGateway } from "../../work-history/app-server-history-gateway";
import { checkpointCodexResume } from "./codex-resume";
import { codexScheduledArgs } from "./codex-options";
import { parseScheduledResult, scheduledPrompt } from "./result";
import { terminalChildren, stopTerminalChildren } from "./terminal-processes";
import type { ScheduledProviderAdapter, ScheduledProviderRequest, ScheduledProviderResult } from "./types";

/** A run owns a fresh terminal for one native Codex turn, never a borrowed TUI. */
export class CodexTerminalScheduledTaskProvider implements ScheduledProviderAdapter {
  readonly provider = "codex" as const;

  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
    private readonly history = new AppServerHistoryGateway(),
  ) {}

  async run(request: ScheduledProviderRequest): Promise<ScheduledProviderResult> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.maxWallTimeMs)]);
    const checkCancelled = (): void => {
      if (signal.aborted) throw new Error(request.signal.aborted ? "provider_cancelled" : "provider_timeout");
    };
    checkCancelled();
    if (request.executionPolicy !== "full-access" || !request.source || !this.options.tmuxService)
      throw new Error("execution_policy_unavailable");
    if (request.resumeThreadId)
      await checkpointCodexResume(request.resumeThreadId, request.workingDirectory);
    checkCancelled();
    const session = await createTerminalSession(this.manager, {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      cwd: request.workingDirectory,
      runtimePreference: "tmux",
    }, { ...this.options, strictDefaultPanel: true, activate: true }, request.source);
    let takenOver = false;
    let unwatch = (): void => {};
    let panelId: string | undefined;
    let operationId: string | undefined;
    let threadId = "";
    let result: ScheduledProviderResult | undefined;
    let failure: unknown;
    let failed = false;
    let stopUnconfirmed = false;
    try {
      const panel = this.manager.listPanels(session.id)[0];
      if (!panel || session.runtimeKind !== "tmux") throw new Error("provider_terminal_changed");
      panelId = panel.id;
      const target = buildPaneTarget(session, this.options.tmuxService, panel);
      await this.manager.updateSessionAlias(session.id, `定时任务 · ${request.name ?? request.runId}`);
      unwatch = observeTerminalInput(session, () => { takenOver = true; });
      const assertOwned = (): void => {
        checkCancelled();
        if (takenOver) throw new Error("provider_terminal_taken_over");
        if (this.manager.getSession(session.id)?.status !== "running" ||
            this.manager.getPanel(panel.id)?.tmuxPaneId !== panel.tmuxPaneId)
          throw new Error("provider_terminal_changed");
        if (operationId && !this.manager.matchesPanelAgentOperationGeneration(session.id, panel.id, operationId, "codex")) {
          takenOver = true;
          throw new Error("provider_terminal_changed");
        }
        const current = resolveConversationTarget(this.manager, session.id, panel.id).target;
        if (threadId && current && (current.threadId !== threadId || current.provider !== "codex")) {
          takenOver = true;
          throw new Error("provider_thread_mismatch");
        }
      };
      // A unique attempt marker distinguishes repeated replies/continuations in the same thread.
      const marker = `RW_SCHEDULED_ATTEMPT_${randomUUID()}`;
      const prompt = scheduledPrompt(`${marker}\n\n${request.prompt}`, request.runId, true);
      const prepared = await prepareTerminalAgent(this.manager, session, this.options, {
        agent: "codex",
        command: settingText("agents.codex.binary")?.trim() || "codex",
        panelId: panel.id,
        cwd: request.workingDirectory,
        prompt,
        ...(request.resumeThreadId ? { resumeThreadId: request.resumeThreadId } : {}),
        args: [...codexScheduledArgs(request), "-c", 'tui.resume_cwd="current"'],
      }, {
        supervisorInput: true,
        stageResumeCommand: true,
        validateLaunchTarget: async () => {
          assertOwned();
          // Preparation may respawn the initial shell. Persist the final pane
          // owner before submitting business input, not that replaced shell PID.
          await request.onSpawn(await this.options.tmuxService!.readPaneProcessId(target));
          assertOwned();
        },
        validateSupervisorTarget: assertOwned,
      });
      operationId = prepared.operationId;
      let unavailableSince: number | null = null;
      let unsettledSince: number | null = null;
      let outputBytes = 0;
      const output = new Map<string, string>();
      while (true) {
        assertOwned();
        const identity = resolveConversationTarget(this.manager, session.id, panel.id).target;
        if (identity) {
          if (identity.provider !== "codex" || (threadId && identity.threadId !== threadId) ||
              (request.resumeThreadId && identity.threadId !== request.resumeThreadId)) {
            takenOver = true;
            throw new Error("provider_thread_mismatch");
          }
          if (!threadId) {
            threadId = identity.threadId;
            await request.onThread(threadId);
          }
          const response = await this.history.getThreadDetail(threadId).catch(() => null);
          assertOwned();
          const detail = response?.availability === "available" && response.detail &&
            "threadId" in response.detail && response.detail.provider === "codex" &&
            response.detail.threadId === threadId ? response.detail : null;
          if (!detail) {
            unavailableSince ??= Date.now();
            if (Date.now() - unavailableSince >= 30_000) throw new Error("provider_history_unavailable");
          } else {
            unavailableSince = null;
            const turns = detail.turns.filter(turn => turn.messages.some(message =>
              message.role === "user" && message.text.includes(marker)));
            if (turns.length > 1) throw new Error("provider_thread_mismatch");
            const turn = turns[0];
            if (turn) {
              for (const message of turn.messages.filter(message => message.role === "assistant")) {
                const previous = output.get(message.id) ?? "";
                if (previous === message.text) continue;
                const text = `${message.text.startsWith(previous) ? message.text.slice(previous.length) : message.text}\n`;
                outputBytes += Buffer.byteLength(text);
                if (outputBytes > request.maxOutputBytes || !(await request.onOutput(text)))
                  throw new Error("provider_output_limit_exceeded");
                output.set(message.id, message.text);
              }
              // The reader can temporarily call a live TUI interrupted. Require
              // its execution-side idle state and a complete native turn together.
              if (this.manager.getPanel(panel.id)?.terminalState?.state === "agent_idle" &&
                  turn.status !== "inProgress" && turn.itemsView === "full") {
                if (turn.status === "completed") {
                  const final = turn.messages.filter(message => message.role === "assistant" && message.phase !== "commentary").at(-1);
                  if (!final) throw new Error("provider_result_invalid");
                  result = { provider: this.provider, threadId, ...parseScheduledResult(final.text) };
                  break;
                }
                // Stop hooks can arrive before the native reader sees the final
                // completion. Keep the original TUI alive while that settles.
                unsettledSince ??= Date.now();
                if (Date.now() - unsettledSince >= 10_000) throw new Error("provider_completion_missing");
              } else {
                unsettledSince = null;
              }
            }
          }
        }
        const pane = (await this.options.tmuxService.listPanes(target)).find(item => item.paneId === target.paneId);
        if (!pane || pane.agentPrepareExit?.startsWith(`exit:${prepared.operationId}:`))
          throw new Error("provider_completion_missing");
        await delay(1_000, undefined, { signal }).catch(() => { checkCancelled(); });
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        if (!takenOver && !result && panelId && operationId) {
          try {
            takenOver = !(await this.interrupt(session.id, panelId, operationId, threadId, () => takenOver));
          } catch { stopUnconfirmed = true; }
        }
        if ((takenOver || stopUnconfirmed) && panelId) {
          await request.onTerminalRetained?.({
            terminalSessionId: session.id, panelId,
            attachmentState: stopUnconfirmed ? "failed" : "ready",
            ...(stopUnconfirmed ? { error: "provider_stop_unconfirmed" } : {}),
          });
        } else {
          const deleted = await deleteTerminalSession(session.id, { ...this.options, terminalSessionManager: this.manager });
          if (deleted) this.options.terminalEventService?.record({
            kind: "terminal_session_deleted", terminalSessionId: session.id, projectId: session.projectId,
            payload: { terminalSessionId: session.id, projectId: session.projectId },
          });
          if (deleted) recordTerminalSessionDeleted(this.options.activity, session);
        }
      } finally {
        unwatch();
      }
    }
    if (stopUnconfirmed) throw new Error("provider_stop_unconfirmed");
    if (failed) throw failure;
    return result!;
  }

  private async interrupt(sessionId: string, panelId: string, operationId: string, threadId: string, takenOver: () => boolean): Promise<boolean> {
    const session = this.manager.getSession(sessionId);
    const panel = this.manager.getPanel(panelId);
    if (!session || !panel || !this.options.tmuxService) return true;
    const owned = (): boolean => {
      const current = resolveConversationTarget(this.manager, sessionId, panelId).target;
      return !takenOver() && this.manager.matchesPanelAgentOperationGeneration(sessionId, panelId, operationId, "codex") &&
        (!threadId || !current || (current.provider === "codex" && current.threadId === threadId));
    };
    if (!owned()) return false;
    const panePid = await this.options.tmuxService.readPaneProcessId(buildPaneTarget(session, this.options.tmuxService, panel));
    const children = await terminalChildren(panePid);
    if (!owned()) return false;
    // Interrupt the original turn, then stop its private process tree. Native
    // exec sessions can survive both Escape and removal of the tmux pane.
    await sendInputToSession(this.manager, { ...this.options, supervisorInput: true,
      validateSupervisorTarget: () => { if (!owned()) throw new Error("provider_terminal_taken_over"); },
    }, session, "\u001b", "raw", undefined, buildPaneTarget(session, this.options.tmuxService, panel));
    if (!owned()) return false;
    const afterInterrupt = await terminalChildren(panePid);
    if (!owned()) return false;
    await stopTerminalChildren([...children, ...afterInterrupt]);
    return !takenOver();
  }
}
