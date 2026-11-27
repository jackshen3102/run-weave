import { randomUUID } from "node:crypto";
import type { AnswerTerminalQuestionRequest, TerminalQuestionsResponse } from "@runweave/shared/terminal/questions";
import type { TerminalSessionManager } from "../manager/manager";
import type { TmuxService } from "../tmux/service";
import { buildPaneTarget } from "../application/panel-common";
import { resolvePanelTarget } from "../application/panel-targets";
import { resolveReplyThread } from "../completion/reply-preview";
import { findQuestionExecutor } from "./executor";
import { QuestionConflict, TerminalQuestionGateway } from "./gateway";
import type { DeviceSubscriptions } from "../../device-monitor/subscriptions";
import { TerminalQuestionNotifications } from "./notifications";
import type { OriginalTerminalQuestion, TerminalQuestionOrigin } from "./origin";

export class TerminalQuestionsService {
  private generation = randomUUID();
  private closed = false;
  private connections = new Map<string, {
    identity: string;
    panelId: string;
    threadId: string;
    gateway: TerminalQuestionGateway;
    ready: Promise<void>;
  }>();
  readonly notifications?: TerminalQuestionNotifications;
  constructor(private manager: TerminalSessionManager, private tmux: TmuxService, subscriptions?: DeviceSubscriptions) {
    if (subscriptions) this.notifications = new TerminalQuestionNotifications(this, subscriptions);
  }

  private async target(terminalId: string, panelId?: string, expectedThreadId?: string) {
    const session = this.manager.getSession(terminalId);
    if (!session || session.status !== "running" || session.runtimeKind !== "tmux") return null;
    // Also synchronize the actual selected tmux pane before checking an explicit old panel.
    const selected = await resolvePanelTarget(this.manager, session, { tmuxService: this.tmux }, {}, "explicit-or-active");
    if (panelId && panelId !== selected.panel.id) throw new QuestionConflict("终端面板已切换，请重新打开回复辅助");
    const { panel, paneTarget } = selected;
    const thread = resolveReplyThread(panel) ?? (this.manager.listPanels(terminalId).length === 1 ? resolveReplyThread(session) : null);
    if (panel.status !== "running" || panel.terminalState?.agent !== "codex" || thread?.provider !== "codex") return null;
    if (expectedThreadId && thread.id !== expectedThreadId) {
      return { terminalId, panelId: panel.id, threadId: thread.id, executor: null };
    }
    const { panePid } = await this.tmux.textAttachmentProcessIdentity(paneTarget);
    const executor = await findQuestionExecutor(panePid);
    return { terminalId, panelId: panel.id, threadId: thread.id, executor };
  }

  async hasRemoteExecutor(terminalId: string, panelId: string): Promise<boolean> {
    const session = this.manager.getSession(terminalId);
    const panel = this.manager.getPanel(panelId);
    if (!session || session.status !== "running" || session.runtimeKind !== "tmux" ||
        !panel || panel.status !== "running" || panel.terminalSessionId !== session.id || !panel.tmuxPaneId) {
      return false;
    }
    try {
      const paneTarget = buildPaneTarget(session, this.tmux, panel);
      const { panePid } = await this.tmux.textAttachmentProcessIdentity(paneTarget);
      return Boolean(await findQuestionExecutor(panePid));
    } catch {
      return false;
    }
  }

  isSessionPanelRunning(terminalId: string, panelId: string): boolean {
    const session = this.manager.getSession(terminalId);
    if (!session || session.status !== "running") return false;
    if (!panelId) return true;
    const panel = this.manager.getPanel(panelId);
    return !!panel && panel.status === "running" && panel.terminalSessionId === session.id;
  }

  isTerminalAgentActive(terminalId: string, panelId: string): boolean {
    if (!this.isSessionPanelRunning(terminalId, panelId)) return false;
    const session = this.manager.getSession(terminalId)!;
    const panel = panelId ? this.manager.getPanel(panelId) : undefined;
    if (panel) {
      return panel.terminalState?.state === "agent_running" ||
        panel.oscProgramStatus?.state === "blocked" ||
        Boolean(panel.pendingAgyQuestion || panel.pendingPermissionRequest || panel.pi?.event === "ui_prompt_start");
    }
    return session.terminalState?.state === "agent_running" ||
      session.oscProgramStatus?.state === "blocked" ||
      Boolean(session.pi?.event === "ui_prompt_start");
  }

  async readOriginal(origin: TerminalQuestionOrigin): Promise<OriginalTerminalQuestion> {
    const session = this.manager.getSession(origin.terminalId);
    const panel = this.manager.getPanel(origin.panelId);
    if (!session || session.status === "exited" || !panel || panel.status === "exited") {
      return { status: "closed" } as const;
    }
    try {
      const value = await this.read(origin.terminalId, origin.panelId, origin.threadId);
      if (value.target && value.target.threadId !== origin.threadId) return { status: "closed" } as const;
      if (value.capability === "unsupported") return { status: "unsupported" } as const;
      if (value.capability !== "available" || !value.target) return { status: "unavailable" } as const;
      const request = value.requests.find((entry) => entry.turnId === origin.turnId && entry.itemId === origin.itemId);
      return { status: "available", request, value } as const;
    } catch {
      // A different selected pane or an unreachable executor can be checked again.
      return { status: "unavailable" } as const;
    }
  }

  isPending(origin: TerminalQuestionOrigin): boolean {
    const connection = this.connections.get(origin.terminalId);
    const session = this.manager.getSession(origin.terminalId);
    const panel = this.manager.getPanel(origin.panelId);
    const thread = panel && (resolveReplyThread(panel) ??
      (session && this.manager.listPanels(origin.terminalId).length === 1 ? resolveReplyThread(session) : null));
    return !!connection && connection.gateway.threadId === origin.threadId &&
      session?.status === "running" && panel?.status === "running" && thread?.id === origin.threadId &&
      this.manager.getPanelWorkspace(origin.terminalId)?.activePanelId === origin.panelId &&
      connection.gateway.isPending(origin.turnId, origin.itemId);
  }

  observeQuestion(origin: TerminalQuestionOrigin): void {
    if (this.closed) return;
    void (async () => {
      for (const [id, entry] of this.connections) if (entry.gateway.disposed) this.invalidate(id);
      const session = this.manager.getSession(origin.terminalId);
      const panel = this.manager.getPanel(origin.panelId);
      if (
        !session ||
        session.status !== "running" ||
        session.runtimeKind !== "tmux" ||
        !panel ||
        panel.status !== "running" ||
        panel.terminalSessionId !== session.id ||
        !panel.tmuxPaneId
      ) {
        return;
      }
      const paneTarget = buildPaneTarget(session, this.tmux, panel);
      const { panePid } = await this.tmux.textAttachmentProcessIdentity(paneTarget);
      const executor = await findQuestionExecutor(panePid);
      if (!executor || this.closed) return;
      const identity = JSON.stringify([panel.id, origin.threadId, executor.pid, executor.socket]);
      let connection = this.connections.get(origin.terminalId);
      if (connection && connection.identity === identity && !connection.gateway.disposed) {
        await connection.ready;
        return;
      }
      if (connection) {
        const activePending = connection.gateway.activePending();
        if (connection.gateway.connected && activePending) return;
        this.invalidate(origin.terminalId);
      }
      if (this.connections.size >= 128) return;
      const gateway = new TerminalQuestionGateway(executor.socket, origin.threadId, (request, state) => {
        this.notifications?.recordEnd({
          terminalId: origin.terminalId, panelId: panel.id, threadId: origin.threadId,
          turnId: request.turnId, itemId: request.itemId,
        }, state);
      });
      connection = {
        identity,
        panelId: panel.id,
        threadId: origin.threadId,
        gateway,
        ready: gateway.join().catch(() => { gateway.dispose(); }),
      };
      this.connections.set(origin.terminalId, connection);
      await connection.ready;
    })().catch(() => undefined);
  }

  findActivePendingQuestion(terminalId: string): {
    panelId: string;
    threadId: string;
    turnId: string;
    itemId: string;
    updatedAt: string;
  } | null {
    const connection = this.connections.get(terminalId);
    const session = this.manager.getSession(terminalId);
    const panel = connection && this.manager.getPanel(connection.panelId);
    const thread = panel && (resolveReplyThread(panel) ??
      (session && this.manager.listPanels(terminalId).length === 1 ? resolveReplyThread(session) : null));
    if (this.closed || !connection || connection.gateway.disposed || !connection.gateway.connected ||
      session?.status !== "running" || panel?.status !== "running" ||
      (thread != null && thread.id !== connection.threadId)) return null;
    const pending = connection.gateway.activePending();
    if (!pending) return null;
    return {
      panelId: connection.panelId,
      threadId: connection.threadId,
      turnId: pending.request.turnId,
      itemId: pending.request.itemId,
      updatedAt: pending.observedAt,
    };
  }

  async read(terminalId: string, panelId?: string, expectedThreadId?: string): Promise<TerminalQuestionsResponse> {
    for (const [id, connection] of this.connections) if (connection.gateway.disposed) this.invalidate(id);
    const target = this.closed ? null : await this.target(terminalId, panelId, expectedThreadId);
    const fallback = (capability: "unsupported" | "disconnected", reason: string): TerminalQuestionsResponse => ({
      capability, reason, generation: this.generation,
      target: target ? { terminalId, panelId: target.panelId, threadId: target.threadId } : null, requests: [],
    });
    if (target && expectedThreadId && target.threadId !== expectedThreadId) {
      return fallback("unsupported", "原问题所属任务已变化");
    }
    if (!target?.executor) {
      this.invalidate(terminalId);
      return fallback("unsupported", "当前终端未使用可确认的共享执行连接。请回原终端手动回复；不会启动替代任务。");
    }
    const identity = JSON.stringify([target.panelId, target.threadId, target.executor.pid, target.executor.socket]);
    let connection = this.connections.get(terminalId);
    if (connection && connection.identity !== identity) { this.invalidate(terminalId); connection = undefined; }
    if (!connection) {
      if (this.connections.size >= 128) return fallback("disconnected", "回复辅助连接繁忙，请回终端操作");
      const gateway = new TerminalQuestionGateway(target.executor.socket, target.threadId, (request, state) => {
        this.notifications?.recordEnd({
          terminalId, panelId: target.panelId, threadId: target.threadId,
          turnId: request.turnId, itemId: request.itemId,
        }, state);
      });
      connection = {
        identity,
        panelId: target.panelId,
        threadId: target.threadId,
        gateway,
        ready: gateway.join().catch(() => { gateway.dispose(); }),
      };
      this.connections.set(terminalId, connection);
    }
    await connection.ready;
    if (this.closed || this.connections.get(terminalId) !== connection || !connection.gateway.connected) {
      if (this.connections.get(terminalId) === connection) this.invalidate(terminalId);
      return fallback("disconnected", "原执行连接不可用，答案不会自动重发。请回终端核对。");
    }
    // Async discovery/join must not publish another task's requests after a panel switch.
    const latest = await this.target(terminalId, target.panelId, target.threadId);
    if (!latest?.executor || latest.threadId !== target.threadId || latest.executor.pid !== target.executor.pid || latest.executor.socket !== target.executor.socket) {
      if (this.connections.get(terminalId) === connection) this.invalidate(terminalId);
      throw new QuestionConflict("任务已变化，请重新打开回复辅助");
    }
    if (this.closed || this.connections.get(terminalId) !== connection || !connection.gateway.connected)
      return fallback("disconnected", "原执行连接不可用，请回终端核对。");
    return { capability: "available", reason: null, generation: connection.gateway.generation,
      target: { terminalId, panelId: target.panelId, threadId: target.threadId }, requests: connection.gateway.requests() };
  }

  async answer(terminalId: string, requestId: string, body: AnswerTerminalQuestionRequest): Promise<TerminalQuestionsResponse> {
    // A POST never creates or rejoins a connection. Lost delivery requires explicit user review.
    const connection = this.connections.get(terminalId);
    if (!connection || !connection.gateway.connected || connection.gateway.generation !== body.generation) throw new QuestionConflict("问题连接已变化，答案已保留，请回终端核对");
    const target = await this.target(terminalId, body.panelId);
    if (this.closed || this.connections.get(terminalId) !== connection || !target?.executor ||
      target.threadId !== body.threadId || connection.identity !== JSON.stringify([target.panelId, target.threadId, target.executor.pid, target.executor.socket])) throw new QuestionConflict("原问题所属任务已变化，不能提交旧答案");
    connection.gateway.answer(requestId, body);
    return { capability: "available", reason: null, generation: connection.gateway.generation,
      target: { terminalId, panelId: target.panelId, threadId: target.threadId }, requests: connection.gateway.requests() };
  }

  private invalidate(terminalId: string): void {
    this.connections.get(terminalId)?.gateway.dispose();
    this.connections.delete(terminalId);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const connection of this.connections.values()) connection.gateway.dispose();
    this.connections.clear();
    await this.notifications?.dispose();
  }
}
