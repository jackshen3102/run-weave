import { randomUUID } from "node:crypto";
import type { AnswerTerminalQuestionRequest, TerminalQuestionsResponse } from "@runweave/shared/terminal/questions";
import type { TerminalSessionManager } from "../manager/manager";
import type { TmuxService } from "../tmux/service";
import { resolvePanelTarget } from "../application/panel-targets";
import { resolveReplyThread } from "../completion/reply-preview";
import { findQuestionExecutor } from "./executor";
import { QuestionConflict, TerminalQuestionGateway } from "./gateway";

export class TerminalQuestionsService {
  private generation = randomUUID();
  private closed = false;
  private connections = new Map<string, { identity: string; gateway: TerminalQuestionGateway; ready: Promise<void> }>();
  constructor(private manager: TerminalSessionManager, private tmux: TmuxService) {}

  private async target(terminalId: string, panelId?: string) {
    const session = this.manager.getSession(terminalId);
    if (!session || session.status !== "running" || session.runtimeKind !== "tmux") return null;
    // Also synchronize the actual selected tmux pane before checking an explicit old panel.
    const selected = await resolvePanelTarget(this.manager, session, { tmuxService: this.tmux }, {}, "explicit-or-active");
    if (panelId && panelId !== selected.panel.id) throw new QuestionConflict("终端面板已切换，请重新打开回复辅助");
    const { panel, paneTarget } = selected;
    const thread = resolveReplyThread(panel) ?? (this.manager.listPanels(terminalId).length === 1 ? resolveReplyThread(session) : null);
    if (panel.status !== "running" || panel.terminalState?.agent !== "codex" || thread?.provider !== "codex") return null;
    const { panePid } = await this.tmux.textAttachmentProcessIdentity(paneTarget);
    const executor = await findQuestionExecutor(panePid);
    return { terminalId, panelId: panel.id, threadId: thread.id, executor };
  }

  async read(terminalId: string, panelId?: string): Promise<TerminalQuestionsResponse> {
    for (const [id, connection] of this.connections) if (connection.gateway.disposed) this.invalidate(id);
    const target = this.closed ? null : await this.target(terminalId, panelId);
    const fallback = (capability: "unsupported" | "disconnected", reason: string): TerminalQuestionsResponse => ({
      capability, reason, generation: this.generation,
      target: target ? { terminalId, panelId: target.panelId, threadId: target.threadId } : null, requests: [],
    });
    if (!target?.executor) {
      this.invalidate(terminalId);
      return fallback("unsupported", "当前终端未使用可确认的共享执行连接。请回原终端手动回复；不会启动替代任务。");
    }
    const identity = JSON.stringify([target.panelId, target.threadId, target.executor.pid, target.executor.socket]);
    let connection = this.connections.get(terminalId);
    if (connection && connection.identity !== identity) { this.invalidate(terminalId); connection = undefined; }
    if (!connection) {
      if (this.connections.size >= 128) return fallback("disconnected", "回复辅助连接繁忙，请回终端操作");
      const gateway = new TerminalQuestionGateway(target.executor.socket, target.threadId);
      connection = { identity, gateway, ready: gateway.join().catch(() => { gateway.dispose(); }) };
      this.connections.set(terminalId, connection);
    }
    await connection.ready;
    if (this.closed || this.connections.get(terminalId) !== connection || !connection.gateway.connected) {
      if (this.connections.get(terminalId) === connection) this.invalidate(terminalId);
      return fallback("disconnected", "原执行连接不可用，答案不会自动重发。请回终端核对。");
    }
    // Async discovery/join must not publish another task's requests after a panel switch.
    const latest = await this.target(terminalId, target.panelId);
    if (!latest?.executor || latest.threadId !== target.threadId || latest.executor.pid !== target.executor.pid || latest.executor.socket !== target.executor.socket) {
      this.invalidate(terminalId); throw new QuestionConflict("任务已变化，请重新打开回复辅助");
    }
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
  dispose(): void {
    this.closed = true;
    for (const connection of this.connections.values()) connection.gateway.dispose();
    this.connections.clear();
  }
}
