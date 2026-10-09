import { CodexAppServerClient } from "../../voice/codex-app-server-client";
import { settingText } from "@runweave/config-node";
import type { ForkTerminalAgentRequest, ForkTerminalAgentResponse, TerminalAgentForkTarget } from "@runweave/shared/terminal/agent-fork";
import type { TerminalSessionManager } from "../manager/manager";
import { resolveReplyThread } from "../completion/reply-preview";
import { prepareTerminalAgent } from "./agent-preparation";
import { createTerminalSession, type TerminalSessionCreationOptions } from "./create-session";
import { TerminalPanelError } from "./panel-common";
import { resolvePanelTarget } from "./panel-targets";
import { TMUX_AGENT_PREPARE_EXIT_OPTION } from "../tmux/service";

type Operation = { fingerprint: string; result: Promise<ForkTerminalAgentResponse>; settledAt?: number };

/** A fork owns a new terminal; it never sends input to its source. */
export class TerminalAgentForkService {
  private operations = new Map<string, Operation>();
  private pendingPanels = new Set<string>();

  constructor(private manager: TerminalSessionManager, private options: TerminalSessionCreationOptions) {}

  async target(terminalId: string): Promise<TerminalAgentForkTarget> {
    const session = this.manager.getSession(terminalId);
    if (!session) throw new TerminalPanelError(404, "终端不存在");
    if (session.status !== "running" || session.runtimeKind !== "tmux") {
      throw new TerminalPanelError(409, "当前终端不支持 Fork Codex");
    }
    const { panel } = await resolvePanelTarget(this.manager, session, this.options, {}, "explicit-or-active");
    const thread = resolveReplyThread(panel);
    if (panel.status !== "running" || panel.terminalState?.state !== "agent_idle" ||
      panel.terminalState.agent !== "codex" || thread?.provider !== "codex" || panel.agentTeamRunId) {
      throw new TerminalPanelError(409, "请等待当前 Codex 会话空闲后再 Fork");
    }
    return { panelId: panel.id, threadId: thread.id, cwd: panel.cwd,
      revision: this.revision(terminalId, panel.id, thread.id) };
  }

  fork(terminalId: string, request: ForkTerminalAgentRequest): Promise<ForkTerminalAgentResponse> {
    const fingerprint = JSON.stringify([terminalId, request.panelId, request.expectedThreadId, request.expectedRevision]);
    const existing = this.operations.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new TerminalPanelError(409, "Fork 请求已用于另一个会话");
      return existing.result;
    }
    // Bound receipts without evicting an in-flight or recently ambiguous write.
    for (const [id, operation] of this.operations) {
      if (operation.settledAt && Date.now() - operation.settledAt > 60 * 60_000) this.operations.delete(id);
    }
    if (this.operations.size >= 512) throw new TerminalPanelError(503, "Fork 请求繁忙，请稍后重试");
    if (this.pendingPanels.has(request.panelId)) throw new TerminalPanelError(409, "这个会话正在 Fork，请先核对新终端");
    this.pendingPanels.add(request.panelId);
    const operation: Operation = { fingerprint, result: this.create(terminalId, request) };
    this.operations.set(request.operationId, operation);
    void operation.result.finally(() => {
      operation.settledAt = Date.now();
      this.pendingPanels.delete(request.panelId);
    }).catch(() => undefined);
    return operation.result;
  }

  private revision(terminalId: string, panelId: string, threadId: string): string {
    return JSON.stringify([panelId, threadId, this.manager.getPanel(panelId)?.lastThreadUpdatedAt?.toISOString() ?? null,
      this.manager.getPanelAgentOperationGeneration(terminalId, panelId)?.operationId ?? null]);
  }

  private assertSource(terminalId: string, request: ForkTerminalAgentRequest): void {
    const session = this.manager.getSession(terminalId);
    const panel = this.manager.getPanel(request.panelId);
    const thread = panel && resolveReplyThread(panel);
    if (session?.status !== "running" || panel?.terminalSessionId !== terminalId || panel.status !== "running" ||
      panel.terminalState?.state !== "agent_idle" || panel.terminalState.agent !== "codex" || panel.agentTeamRunId ||
      this.manager.getPanelWorkspace(terminalId)?.activePanelId !== request.panelId ||
      thread?.provider !== "codex" || thread.id !== request.expectedThreadId ||
      this.revision(terminalId, panel.id, thread.id) !== request.expectedRevision) {
      throw new TerminalPanelError(409, "来源 Codex 会话已变化，请重新打开终端菜单");
    }
  }

  private async create(terminalId: string, request: ForkTerminalAgentRequest): Promise<ForkTerminalAgentResponse> {
    const target = await this.target(terminalId);
    this.assertSource(terminalId, request);
    if (target.panelId !== request.panelId) throw new TerminalPanelError(409, "来源终端面板已切换");
    const session = await createTerminalSession(this.manager, {
      inheritFromTerminalSessionId: terminalId, cwd: target.cwd, runtimePreference: "tmux",
    }, { ...this.options, strictDefaultPanel: true });
    try {
      const panelId = this.manager.getPanelWorkspace(session.id)?.activePanelId;
      if (!panelId) throw new Error("新终端面板尚未就绪");
      const native = new CodexAppServerClient();
      let forkedThreadId: string;
      try {
        this.assertSource(terminalId, request);
        const result = await native.sendRequest("thread/fork", {
          threadId: target.threadId, cwd: target.cwd, persistExtendedHistory: true,
        }) as { thread?: { id?: string; forkedFromId?: string } };
        if (!result.thread?.id || result.thread.id === target.threadId || result.thread.forkedFromId !== target.threadId) {
          throw new Error("原生分叉身份尚未确认");
        }
        forkedThreadId = result.thread.id;
      } finally { native.shutdown(); }
      const started = await prepareTerminalAgent(this.manager, session, this.options, {
        agent: "codex", prompt: "", panelId, cwd: target.cwd,
        command: settingText("agents.codex.binary") ?? "codex",
        args: ["-c", 'tui.resume_cwd="current"', "resume", forkedThreadId],
      }, { skipInitialPrompt: true, validateLaunchTarget: async () => {
        await this.target(terminalId);
        this.assertSource(terminalId, request);
      } });
      await this.manager.updatePanelThreadId(panelId, forkedThreadId, "codex", started.operationId);
      await this.manager.updateSessionThreadId(session.id, forkedThreadId, "codex");
      if (!this.manager.matchesPanelAgentOperationGeneration(session.id, panelId, started.operationId, "codex")) {
        throw new Error("新终端启动操作已变化");
      }
      const panel = this.manager.getPanel(panelId);
      if (!panel || this.manager.getSession(session.id)?.status !== "running") throw new Error("新终端已关闭");
      const exit = await this.options.tmuxService!.readPaneOption({
        ...this.options.tmuxService!.buildTarget(session.id), paneId: panel.tmuxPaneId,
      }, TMUX_AGENT_PREPARE_EXIT_OPTION);
      if (exit?.startsWith(`exit:${started.operationId}:`)) throw new Error("Codex 启动已退出");
      // Codex emits SessionStart only on the first user turn. A native fork and
      // a submitted resume are confirmed here; lifecycle hooks still own readiness.
      return { terminalSessionId: session.id, panelId, threadId: forkedThreadId,
        sourceThreadId: target.threadId, status: "starting" };
    } catch {
      // A submitted native fork may already exist. Keep its terminal for inspection.
      throw new TerminalPanelError(409, "Fork 尚未确认，请先查看新终端；不会自动重试", { terminalSessionId: session.id });
    }
  }
}
