import { CodexAppServerClient, resolveCodexLaunchPlan } from "../../voice/codex-app-server-client";
import { logger } from "../../logging/index";
import { settingText } from "@runweave/config-node";
import type { ForkTerminalAgentRequest, ForkTerminalAgentResponse, TerminalAgentForkTarget } from "@runweave/shared/terminal/agent-fork";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import { resolveReplyThread } from "../completion/reply-preview";
import { prepareTerminalAgent } from "./agent-preparation";
import { createTerminalSession, type TerminalSessionCreationOptions } from "./create-session";
import { TerminalPanelError } from "./panel-common";
import { resolvePanelTarget } from "./panel-targets";
import { resolveEffectiveTerminalState } from "./terminal-state-projection";
import { TMUX_AGENT_PREPARE_EXIT_OPTION } from "../tmux/service";

type Operation = { fingerprint: string; result: Promise<ForkTerminalAgentResponse>; settledAt?: number };
const PTY_PANEL_ID = "default";

/** A fork owns a new terminal; it never sends input to its source. */
export class TerminalAgentForkService {
  private operations = new Map<string, Operation>();
  private pendingPanels = new Set<string>();

  constructor(private manager: TerminalSessionManager, private options: TerminalSessionCreationOptions, private readonly readOnlySource = false) {}

  async target(terminalId: string): Promise<TerminalAgentForkTarget> {
    const session = this.manager.getSession(terminalId);
    if (!session) throw new TerminalPanelError(404, "终端不存在");
    if (session.status !== "running") {
      throw new TerminalPanelError(409, "当前终端不支持 Fork Codex");
    }
    if (session.runtimeKind === "pty") {
      const target = this.ptyTarget(session);
      if (target) return target;
      throw new TerminalPanelError(409, "请等待当前 Codex 会话空闲后再 Fork");
    }
    const activeId = this.manager.getPanelWorkspace(terminalId)?.activePanelId;
    const panel = this.readOnlySource
      ? activeId && this.manager.getPanel(activeId)
      : (await resolvePanelTarget(this.manager, session, this.options, {}, "explicit-or-active")).panel;
    if (!panel || panel.terminalSessionId !== terminalId) throw new TerminalPanelError(409, "来源面板不可用");
    if (this.readOnlySource) {
      const tmux = this.options.tmuxService;
      const selected = tmux && await tmux.readSelectedPane(tmux.buildTarget(terminalId));
      if (selected !== panel.tmuxPaneId) throw new TerminalPanelError(409, "来源面板已切换");
    }
    const thread = resolveReplyThread(panel);
    if (panel.status !== "running" || panel.terminalState?.state !== "agent_idle" ||
      panel.terminalState.agent !== "codex" || thread?.provider !== "codex") {
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
    const panelKey = JSON.stringify([terminalId, request.panelId]);
    if (this.pendingPanels.has(panelKey)) throw new TerminalPanelError(409, "这个会话正在 Fork，请先核对新终端");
    this.pendingPanels.add(panelKey);
    const operation: Operation = { fingerprint, result: this.create(terminalId, request) };
    this.operations.set(request.operationId, operation);
    void operation.result.finally(() => {
      operation.settledAt = Date.now();
      this.pendingPanels.delete(panelKey);
    }).catch(() => undefined);
    return operation.result;
  }

  private revision(terminalId: string, panelId: string, threadId: string): string {
    return JSON.stringify([panelId, threadId, this.manager.getPanel(panelId)?.lastThreadUpdatedAt?.toISOString() ?? null,
      this.manager.getPanelAgentOperationGeneration(terminalId, panelId)?.operationId ?? null]);
  }

  private assertSource(terminalId: string, request: ForkTerminalAgentRequest): void {
    const session = this.manager.getSession(terminalId);
    if (session?.runtimeKind === "pty") {
      const target = this.ptyTarget(session);
      if (target?.panelId === request.panelId && target.threadId === request.expectedThreadId &&
          target.revision === request.expectedRevision) return;
      throw new TerminalPanelError(409, "来源 Codex 会话已变化，请重新打开终端菜单");
    }
    const panel = this.manager.getPanel(request.panelId);
    const thread = panel && resolveReplyThread(panel);
    if (session?.status !== "running" || panel?.terminalSessionId !== terminalId || panel.status !== "running" ||
      panel.terminalState?.state !== "agent_idle" || panel.terminalState.agent !== "codex" ||
      this.manager.getPanelWorkspace(terminalId)?.activePanelId !== request.panelId ||
      thread?.provider !== "codex" || thread.id !== request.expectedThreadId ||
      this.revision(terminalId, panel.id, thread.id) !== request.expectedRevision) {
      throw new TerminalPanelError(409, "来源 Codex 会话已变化，请重新打开终端菜单");
    }
  }

  private ptyTarget(session: TerminalSessionRecord): TerminalAgentForkTarget | null {
    const state = resolveEffectiveTerminalState(this.manager, this.options.terminalStateService, session);
    const thread = resolveReplyThread(session);
    if (session.status !== "running" || !this.options.runtimeRegistry?.getSessionRuntime(session.id) ||
        state?.state !== "agent_idle" || state.agent !== "codex" || thread?.provider !== "codex") return null;
    return { panelId: PTY_PANEL_ID, threadId: thread.id, cwd: session.cwd,
      revision: JSON.stringify([session.id, thread.id, session.cwd, session.lastThreadUpdatedAt?.toISOString(),
        session.ptyHost?.hostInstanceId, session.ptyHost?.sessionInstanceId]) };
  }

  private async forkNative(target: TerminalAgentForkTarget): Promise<string> {
    const native = new CodexAppServerClient();
    try {
      const result = await native.sendRequest("thread/fork", {
        threadId: target.threadId, cwd: target.cwd, persistExtendedHistory: true,
      }) as { thread?: { id?: string; forkedFromId?: string } };
      if (!result.thread?.id || result.thread.id === target.threadId || result.thread.forkedFromId !== target.threadId) {
        throw new Error("原生分叉身份尚未确认");
      }
      return result.thread.id;
    } finally {
      native.shutdown();
    }
  }

  private async create(terminalId: string, request: ForkTerminalAgentRequest): Promise<ForkTerminalAgentResponse> {
    const target = await this.target(terminalId);
    this.assertSource(terminalId, request);
    if (target.panelId !== request.panelId) throw new TerminalPanelError(409, "来源终端面板已切换");
    if (this.manager.getSession(terminalId)?.runtimeKind === "pty") {
      return this.createPtyFork(terminalId, request, target);
    }
    const session = await createTerminalSession(this.manager, {
      inheritFromTerminalSessionId: terminalId, cwd: target.cwd, runtimePreference: "tmux",
    }, { ...this.options, strictDefaultPanel: true });
    try {
      const panelId = this.manager.getPanelWorkspace(session.id)?.activePanelId;
      if (!panelId) throw new Error("新终端面板尚未就绪");
      this.assertSource(terminalId, request);
      const forkedThreadId = await this.forkNative(target);
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

  private async createPtyFork(
    terminalId: string, request: ForkTerminalAgentRequest, target: TerminalAgentForkTarget,
  ): Promise<ForkTerminalAgentResponse> {
    const { command } = resolveCodexLaunchPlan(process.env, "codex");
    let forkedThreadId: string | undefined;
    let createdId: string | undefined;
    try {
      forkedThreadId = await this.forkNative(target);
      this.assertSource(terminalId, request);
      const threadId = forkedThreadId;
      const session = await createTerminalSession(this.manager, {
        inheritFromTerminalSessionId: terminalId, cwd: target.cwd, runtimePreference: "pty", command,
        args: ["-c", "check_for_update_on_startup=false", "-c", 'tui.resume_cwd="current"', "resume", threadId],
      }, {
        ...this.options,
        onSessionCreated: async (id) => {
          await this.manager.updateSessionMetadata(id, { cwd: target.cwd, activeCommand: "codex" });
          await this.manager.updateSessionThreadId(id, threadId, "codex");
          await this.manager.updateSessionTerminalState(id, { state: "agent_starting", agent: "codex" });
          this.assertSource(terminalId, request);
        },
      });
      createdId = session.id;
      if (session.status !== "running") throw new Error("Codex 启动已退出");
      return { terminalSessionId: session.id, panelId: PTY_PANEL_ID, threadId,
        sourceThreadId: target.threadId, status: "starting" };
    } catch (error) {
      logger.warn("terminal.agent-fork.pty.failed", { terminalId, createdId, forkedThreadId, error });
      throw new TerminalPanelError(409, "Fork 尚未确认，请核对终端列表；不会自动重试",
        createdId ? { terminalSessionId: createdId } : undefined);
    }
  }
}
