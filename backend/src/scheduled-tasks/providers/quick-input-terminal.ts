import { realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { settingText } from "@runweave/config-node";
import type { PreviousSupervisionContinuation } from "@runweave/shared/task-supervision";
import {
  createTerminalSession,
  type TerminalSessionCreationOptions,
} from "../../terminal/application/create-session";
import { deleteTerminalSession } from "../../terminal/application/delete-session";
import { prepareTerminalAgent } from "../../terminal/application/agent-preparation";
import { sendInputToSession } from "../../terminal/application/input-dispatcher";
import { resolveConversationTarget } from "../../terminal/application/conversation";
import { buildPaneTarget } from "../../terminal/application/panel-common";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import {
  beginSupervisorDelivery,
  hasPendingTerminalInput,
  observeTerminalInput,
} from "../../terminal/runtime/input-admission";
import { recordTerminalSessionDeleted } from "../../terminal/runtime/activity-events";
import { AppServerHistoryGateway } from "../../work-history/app-server-history-gateway";
import { checkpointCodexResume } from "./codex-resume";
import { codexScheduledArgs } from "./codex-options";
import {
  createDefaultQuickInputClassifier,
  evaluateQuickInputTurn,
  type QuickInputTurnClassifier,
} from "./quick-input-verdict";
import { stopTerminalChildren, terminalChildren } from "./terminal-processes";
import type {
  ScheduledProviderAdapter,
  ScheduledProviderRequest,
  ScheduledProviderResult,
} from "./types";

export type { QuickInputTurnClassifier, QuickInputTurnVerdict } from "./quick-input-verdict";

export class QuickInputTerminalScheduledTaskProvider
  implements ScheduledProviderAdapter
{
  readonly provider = "codex" as const;
  private readonly classify: QuickInputTurnClassifier;

  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
    classifierDirectory: string,
    private readonly history = new AppServerHistoryGateway(),
    classifier?: QuickInputTurnClassifier,
    private readonly codexBinary?: string,
  ) {
    this.classify =
      classifier ?? createDefaultQuickInputClassifier(classifierDirectory);
  }

  async run(
    request: ScheduledProviderRequest,
  ): Promise<ScheduledProviderResult> {
    const deadlineAt = Date.now() + request.maxWallTimeMs;
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(request.maxWallTimeMs),
    ]);
    const checkCancelled = (): void => {
      if (signal.aborted) {
        throw new Error(
          request.signal.aborted ? "provider_cancelled" : "provider_timeout",
        );
      }
    };
    checkCancelled();
    if (!request.source || !this.options.tmuxService) {
      throw new Error("execution_policy_unavailable");
    }
    const initialTurnCount = await this.prepareInitialTurnCount(request);
    checkCancelled();

    const session = await createTerminalSession(
      this.manager,
      {
        ...(request.projectId ? { projectId: request.projectId } : {}),
        cwd: request.workingDirectory,
        runtimePreference: "tmux",
      },
      { ...this.options, strictDefaultPanel: true, activate: false },
      request.source,
    );

    let takenOver = false;
    let retainTerminal = false;
    let unwatch = (): void => {};
    let panelId: string | undefined;
    let operationId: string | undefined;
    let threadId = request.resumeThreadId ?? "";
    let result: ScheduledProviderResult | undefined;
    let failure: unknown;
    let failed = false;
    let stopUnconfirmed = false;

    try {
      const panel = this.manager.listPanels(session.id)[0];
      if (!panel || session.runtimeKind !== "tmux") {
        throw new Error("provider_terminal_changed");
      }
      panelId = panel.id;
      const target = buildPaneTarget(session, this.options.tmuxService, panel);
      await this.manager.updateSessionAlias(
        session.id,
        `快捷指令 · ${request.name ?? request.runId}`,
      );
      unwatch = observeTerminalInput(session, () => {
        takenOver = true;
      });
      const assertOwned = (): void => {
        checkCancelled();
        if (takenOver) throw new Error("provider_terminal_taken_over");
        if (
          this.manager.getSession(session.id)?.status !== "running" ||
          this.manager.getPanel(panel.id)?.tmuxPaneId !== panel.tmuxPaneId
        ) {
          throw new Error("provider_terminal_changed");
        }
        if (
          operationId &&
          !this.manager.matchesPanelAgentOperationGeneration(
            session.id,
            panel.id,
            operationId,
            "codex",
          )
        ) {
          takenOver = true;
          throw new Error("provider_terminal_changed");
        }
        const current = resolveConversationTarget(
          this.manager,
          session.id,
          panel.id,
        ).target;
        if (
          threadId &&
          current &&
          (current.threadId !== threadId || current.provider !== "codex")
        ) {
          takenOver = true;
          throw new Error("provider_thread_mismatch");
        }
      };

      const resolvedWorkingDirectory = resolveRealWorkingDirectory(
        request.workingDirectory,
      );
      const prepared = await prepareTerminalAgent(
        this.manager,
        session,
        this.options,
        {
          agent: "codex",
          command:
            this.codexBinary?.trim() ||
            settingText("agents.codex.binary")?.trim() ||
            "codex",
          panelId: panel.id,
          cwd: request.workingDirectory,
          prompt: request.prompt,
          ...(request.resumeThreadId
            ? { resumeThreadId: request.resumeThreadId }
            : {}),
          args: [
            ...codexScheduledArgs(request),
            "-c",
            'tui.resume_cwd="current"',
            ...(!resolvedWorkingDirectory.includes(".") &&
            !resolvedWorkingDirectory.includes("=")
              ? [
                  "-c",
                  `projects.${resolvedWorkingDirectory}.trust_level="trusted"`,
                ]
              : []),
          ],
        },
        {
          supervisorInput: true,
          stageResumeCommand: true,
          validateLaunchTarget: async () => {
            assertOwned();
            await request.onSpawn(
              await this.options.tmuxService!.readPaneProcessId(target),
            );
            assertOwned();
          },
          validateSupervisorTarget: assertOwned,
        },
      );
      operationId = prepared.operationId;
      if (threadId) await request.onThread(threadId);

      const loopOut = await this.observeLoop({
        request,
        sessionId: session.id,
        panelId: panel.id,
        operationId,
        target,
        initialTurnCount,
        initialThreadId: threadId,
        deadlineAt,
        signal,
        checkCancelled,
        assertOwned,
        markTakenOver: () => {
          takenOver = true;
        },
      });
      threadId = loopOut.threadId;
      retainTerminal = loopOut.retainTerminal;
      result = loopOut.result;
    } catch (error) {
      failed = true;
      failure = error;
      if (!request.signal.aborted) retainTerminal = true;
    } finally {
      try {
        if (!takenOver && !result && panelId && operationId) {
          try {
            takenOver = !(await this.interrupt(
              session.id,
              panelId,
              operationId,
              threadId,
              () => takenOver,
            ));
          } catch {
            stopUnconfirmed = true;
          }
        }
        if ((retainTerminal || takenOver || stopUnconfirmed) && panelId) {
          if (this.manager.getSession(session.id)) {
            await request.onTerminalRetained?.({
              terminalSessionId: session.id,
              panelId,
              attachmentState: stopUnconfirmed ? "failed" : "ready",
              ...(stopUnconfirmed ? { error: "provider_stop_unconfirmed" } : {}),
            });
          }
        } else {
          const deleted = await deleteTerminalSession(session.id, {
            ...this.options,
            terminalSessionManager: this.manager,
          });
          if (deleted) {
            this.options.terminalEventService?.record({
              kind: "terminal_session_deleted",
              terminalSessionId: session.id,
              projectId: session.projectId,
              payload: { terminalSessionId: session.id, projectId: session.projectId },
            });
            recordTerminalSessionDeleted(this.options.activity, session);
          }
        }
      } finally {
        unwatch();
      }
    }
    if (stopUnconfirmed) throw new Error("provider_stop_unconfirmed");
    if (failed) throw failure;
    return result!;
  }

  private async prepareInitialTurnCount(
    request: ScheduledProviderRequest,
  ): Promise<number> {
    if (!request.resumeThreadId) return 0;
    await checkpointCodexResume(
      request.resumeThreadId,
      request.workingDirectory,
    );
    const existing = await this.history
      .getThreadDetail(request.resumeThreadId)
      .catch(() => null);
    return existing?.availability === "available" &&
      existing.detail &&
      "turns" in existing.detail &&
      existing.detail.provider === "codex"
      ? existing.detail.turns.length
      : 0;
  }

  private async observeLoop(ctx: {
    request: ScheduledProviderRequest;
    sessionId: string;
    panelId: string;
    operationId: string;
    target: ReturnType<typeof buildPaneTarget>;
    initialTurnCount: number;
    initialThreadId: string;
    deadlineAt: number;
    signal: AbortSignal;
    checkCancelled: () => void;
    assertOwned: () => void;
    markTakenOver: () => void;
  }): Promise<{
    threadId: string;
    retainTerminal: boolean;
    result: ScheduledProviderResult;
  }> {
    let threadId = ctx.initialThreadId;
    let unavailableSince: number | null = null;
    let unsettledSince: number | null = null;
    let expectedTurnIndex = ctx.initialTurnCount;
    let continuations = 0;
    let previousContinuation: PreviousSupervisionContinuation | undefined;
    let outputBytes = 0;
    let latestAssistantText = "";
    const output = new Map<string, string>();

    while (true) {
      ctx.assertOwned();
      const identity = resolveConversationTarget(
        this.manager,
        ctx.sessionId,
        ctx.panelId,
      ).target;
      if (identity) {
        if (
          identity.provider !== "codex" ||
          (threadId && identity.threadId !== threadId) ||
          (ctx.request.resumeThreadId &&
            identity.threadId !== ctx.request.resumeThreadId)
        ) {
          ctx.markTakenOver();
          throw new Error("provider_thread_mismatch");
        }
        if (!threadId) {
          threadId = identity.threadId;
          await ctx.request.onThread(threadId);
        }
        const response = await this.history
          .getThreadDetail(threadId)
          .catch(() => null);
        ctx.assertOwned();
        const detail =
          response?.availability === "available" &&
          response.detail &&
          "threadId" in response.detail &&
          response.detail.provider === "codex" &&
          response.detail.threadId === threadId
            ? response.detail
            : null;
        if (!detail) {
          unavailableSince ??= Date.now();
          if (Date.now() - unavailableSince >= 30_000) {
            throw new Error("provider_history_unavailable");
          }
        } else {
          unavailableSince = null;
          const runTurns = detail.turns.slice(ctx.initialTurnCount);
          for (const itemTurn of runTurns) {
            for (const message of itemTurn.messages.filter(
              (item) => item.role === "assistant",
            )) {
              const previous = output.get(message.id) ?? "";
              if (previous === message.text) continue;
              const delta = `${message.text.startsWith(previous) ? message.text.slice(previous.length) : message.text}\n`;
              outputBytes += Buffer.byteLength(delta);
              if (
                outputBytes > ctx.request.maxOutputBytes ||
                !(await ctx.request.onOutput(delta))
              ) {
                throw new Error("provider_output_limit_exceeded");
              }
              output.set(message.id, message.text);
              if (message.phase !== "commentary" && message.text.trim()) {
                latestAssistantText = message.text;
              }
            }
          }

          const turn = detail.turns[expectedTurnIndex];
          const currentPanel = this.manager.getPanel(ctx.panelId);
          if (
            turn &&
            currentPanel?.terminalState?.state === "agent_idle" &&
            turn.status !== "inProgress" &&
            turn.itemsView === "full"
          ) {
            if (
              currentPanel.oscProgramStatus?.state === "blocked" ||
              currentPanel.pendingPermissionRequest
            ) {
              return {
                threadId,
                retainTerminal: true,
                result: {
                  provider: this.provider,
                  threadId,
                  outcome: "blocked",
                  summary: latestAssistantText || "终端等待权限或交互确认，已保留终端。",
                  reason: "终端存在待确认的权限或交互请求，已保留执行终端供直接处理。",
                },
              };
            }
            if (turn.status !== "completed") {
              unsettledSince ??= Date.now();
              if (Date.now() - unsettledSince >= 10_000) {
                return {
                  threadId,
                  retainTerminal: true,
                  result: {
                    provider: this.provider,
                    threadId,
                    outcome: "blocked",
                    summary: latestAssistantText || "终端轮次未正常结束，已保留现场供检查。",
                    reason: "终端轮次未确认完成，遵循宁留勿删原则已保留执行终端。",
                  },
                };
              }
            } else {
              const final = turn.messages
                .filter((m) => m.role === "assistant" && m.phase !== "commentary")
                .at(-1);
              if (!final?.text.trim()) {
                return {
                  threadId,
                  retainTerminal: true,
                  result: {
                    provider: this.provider,
                    threadId,
                    outcome: "blocked",
                    summary: "终端轮次已结束，但未读取到最终文本回复，已保留终端。",
                    reason: "未读取到最终文本回复，已保留执行终端供检查。",
                  },
                };
              }
              const session = this.manager.getSession(ctx.sessionId)!;
              const evaluated = await evaluateQuickInputTurn({
                classify: this.classify,
                request: ctx.request,
                threadId,
                turns: runTurns,
                finalMessage: final,
                rawTurnId: turn.id || final.id,
                continuations,
                previousContinuation,
                hasPendingUserInput: hasPendingTerminalInput(
                  session,
                  currentPanel.tmuxPaneId,
                ),
                deadlineAt: ctx.deadlineAt,
                signal: ctx.signal,
                checkCancelled: ctx.checkCancelled,
              });
              ctx.assertOwned();
              if (evaluated.kind === "complete") {
                return { threadId, retainTerminal: false, result: evaluated.result };
              }
              if (evaluated.kind === "retain") {
                return { threadId, retainTerminal: true, result: evaluated.result };
              }
              const release = beginSupervisorDelivery(session);
              try {
                await sendInputToSession(
                  this.manager,
                  {
                    ...this.options,
                    supervisorInput: true,
                    validateSupervisorTarget: ctx.assertOwned,
                  },
                  session,
                  evaluated.followUpPrompt,
                  "prompt_paste",
                  evaluated.decisionId,
                  ctx.target,
                );
              } finally {
                await release();
              }
              previousContinuation = evaluated.nextPreviousContinuation;
              continuations += 1;
              expectedTurnIndex = detail.turns.length;
              unsettledSince = null;
              await delay(500, undefined, { signal: ctx.signal }).catch(() => {
                ctx.checkCancelled();
              });
              continue;
            }
          } else {
            unsettledSince = null;
          }
        }
      }
      const pane = (
        await this.options.tmuxService!.listPanes(ctx.target)
      ).find((item) => item.paneId === ctx.target.paneId);
      if (!pane || pane.agentPrepareExit?.startsWith(`exit:${ctx.operationId}:`)) {
        throw new Error("provider_completion_missing");
      }
      await delay(1_000, undefined, { signal: ctx.signal }).catch(() => {
        ctx.checkCancelled();
      });
    }
  }

  private async interrupt(
    sessionId: string,
    panelId: string,
    operationId: string,
    threadId: string,
    takenOver: () => boolean,
  ): Promise<boolean> {
    const session = this.manager.getSession(sessionId);
    const panel = this.manager.getPanel(panelId);
    if (!session || !panel || !this.options.tmuxService) return true;
    const owned = (): boolean => {
      const current = resolveConversationTarget(this.manager, sessionId, panelId).target;
      return (
        !takenOver() &&
        this.manager.matchesPanelAgentOperationGeneration(sessionId, panelId, operationId, "codex") &&
        (!threadId || !current || (current.provider === "codex" && current.threadId === threadId))
      );
    };
    if (!owned()) return false;
    const panePid = await this.options.tmuxService.readPaneProcessId(
      buildPaneTarget(session, this.options.tmuxService, panel),
    );
    const children = await terminalChildren(panePid);
    if (!owned()) return false;
    await sendInputToSession(
      this.manager,
      {
        ...this.options,
        supervisorInput: true,
        validateSupervisorTarget: () => {
          if (!owned()) throw new Error("provider_terminal_taken_over");
        },
      },
      session,
      "\u001b",
      "raw",
      undefined,
      buildPaneTarget(session, this.options.tmuxService, panel),
    );
    if (!owned()) return false;
    const afterInterrupt = await terminalChildren(panePid);
    if (!owned()) return false;
    await stopTerminalChildren([...children, ...afterInterrupt]);
    return !takenOver();
  }
}

function resolveRealWorkingDirectory(workingDirectory: string): string {
  try {
    return realpathSync(workingDirectory);
  } catch {
    return path.resolve(workingDirectory);
  }
}
