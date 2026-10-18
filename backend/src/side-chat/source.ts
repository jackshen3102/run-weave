import { realpathSync } from "node:fs";
import path from "node:path";
import type { SideChatSourceRef, SideChatSourceSnapshot } from "@runweave/shared/side-chat";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { readCodexContext } from "../terminal/runtime/codex-context";
import { getTerminalSessionAgent } from "../terminal/state/terminal-state-service";
import { SideChatError } from "./error";
import { assertLocalSideChatEnvironment, SideChatProvider, type ProviderThread } from "./provider";

export function sourceOwner(manager: TerminalSessionManager, terminalSessionId: string, panelId?: string) {
  const terminal = manager.getSession(terminalSessionId);
  if (!terminal) throw new SideChatError(404, "TERMINAL_NOT_FOUND", "来源终端不存在");
  const id = panelId ?? manager.getPanelWorkspace(terminalSessionId)?.activePanelId;
  const panel = id ? manager.getPanel(id) : undefined;
  if (!panel || panel.terminalSessionId !== terminalSessionId) throw new SideChatError(422, "SOURCE_IDENTITY_UNAVAILABLE", "尚未确认来源终端面板");
  return { terminal, panel };
}
function identity(manager: TerminalSessionManager, terminalId: string, panelId?: string) {
  const { terminal, panel } = sourceOwner(manager, terminalId, panelId);
  const observed = readCodexContext(panel);
  const generation = manager.getPanelAgentOperationGeneration(terminalId, panel.id);
  if (observed.managed && generation && observed.context?.operationId !== generation.operationId)
    throw new SideChatError(422, "SOURCE_GENERATION_UNCONFIRMED", "来源 Codex 启动代次尚未确认");
  const primary = observed.managed ? observed.context?.primaryThreadId : panel.threadId;
  if (observed.managed && (!observed.context || observed.context.closed))
    throw new SideChatError(422, "SOURCE_IDENTITY_UNAVAILABLE", "主 Codex 身份尚未确认");
  // A live managed observation is authoritative before the pane's reading projection catches up.
  if (!primary || getTerminalSessionAgent(panel) !== "codex" || (!observed.managed && panel.threadProvider !== "codex") ||
    terminal.status !== "running" || panel.status !== "running" || /^(ssh|mosh)(\s|$)/.test(path.basename(panel.activeCommand ?? "")))
    throw new SideChatError(422, "SOURCE_UNSUPPORTED", "消息旁聊需要本机运行中、有持久主历史的 Codex");
  return { terminalSessionId: terminalId, panelId: panel.id, expectedPrimaryThreadId: primary, cwd: realpathSync(panel.cwd) };
}
export function sourceKey(ref: SideChatSourceRef): string {
  return JSON.stringify([ref.terminalSessionId, ref.panelId, ref.expectedPrimaryThreadId]);
}
export async function resolveSideChatSource(manager: TerminalSessionManager, terminalId: string, panelId?: string, expected?: SideChatSourceRef): Promise<SideChatSourceSnapshot> {
  const before = identity(manager, terminalId, panelId);
  const provider = new SideChatProvider(before.cwd);
  try {
    await provider.initialize();
    const { thread } = await provider.read(before.expectedPrimaryThreadId).catch((error: unknown) => {
      if (error instanceof SideChatError && error.code === "PROVIDER_REJECTED")
        throw new SideChatError(422, "SOURCE_HISTORY_UNAVAILABLE", "来源历史无法读取，不能建立旁聊");
      throw error;
    });
    if (JSON.stringify(identity(manager, terminalId, panelId)) !== JSON.stringify(before)) throw new SideChatError(409, "SOURCE_CHANGED", "来源已变化，请重新打开旁聊");
    const source = snapshot(thread, before);
    if (expected && (source.expectedPrimaryThreadId !== expected.expectedPrimaryThreadId || source.lastCompletedTurnId !== expected.lastCompletedTurnId))
      throw new SideChatError(409, "SOURCE_CHANGED", "来源完成轮次已更新，请重新打开旁聊");
    return source;
  } finally { await provider.close(); }
}
function snapshot(thread: ProviderThread, identity: { terminalSessionId: string; panelId: string; expectedPrimaryThreadId: string; cwd: string }): SideChatSourceSnapshot {
  // 0.160.1 returns environments:null for stored thread/read, including live local TUIs.
  // Local source ownership is established by the current terminal/panel identity and cwd;
  // fork/resume must still return a verified, single local execution environment.
  if (thread.environments != null) assertLocalSideChatEnvironment(thread, identity.cwd);
  const last = thread.turns.filter(turn => turn.status === "completed").at(-1);
  if (!last || thread.id !== identity.expectedPrimaryThreadId || thread.ephemeral || realpathSync(thread.cwd) !== identity.cwd || !thread.model)
    throw new SideChatError(422, "SOURCE_BOUNDARY_UNAVAILABLE", "找不到完整、已完成的来源轮次");
  const preview = (last.items ?? []).flatMap<{ role: "user" | "assistant"; text: string }>(item => {
    if (item.type === "agentMessage" && item.text && item.phase !== "commentary") return [{ role: "assistant" as const, text: item.text.slice(0, 4000) }];
    const user = item as typeof item & { content?: Array<{ type: string; text?: string }> };
    if (item.type === "userMessage") return [{ role: "user" as const, text: (user.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n").slice(0, 4000) }];
    return [];
  });
  if (!preview.some(item => item.role === "user") || !preview.some(item => item.role === "assistant"))
    throw new SideChatError(422, "SOURCE_HISTORY_INCOMPLETE", "来源历史不完整，无法建立旁聊");
  return { ...identity, lastCompletedTurnId: last.id, turnNumber: thread.turns.findIndex(turn => turn.id === last.id) + 1, model: thread.model, preview,
    permissions: "macOS 本地项目只读；系统运行所需读取；临时目录禁用；无网络、MCP、Apps、Hooks、子 Agent、自动目标续接或提权" };
}

export function assertSideChatSourceIdentity(manager: TerminalSessionManager, source: SideChatSourceSnapshot): void {
  const current = identity(manager, source.terminalSessionId, source.panelId);
  if (current.expectedPrimaryThreadId !== source.expectedPrimaryThreadId || current.cwd !== source.cwd)
    throw new SideChatError(409, "SOURCE_CHANGED", "来源主会话已变化");
}

export function sideChatSourceStatus(manager: TerminalSessionManager, source: SideChatSourceSnapshot): "running" | "idle" | "unavailable" | "unknown" {
  try {
    const { panel } = sourceOwner(manager, source.terminalSessionId, source.panelId);
    const { managed, context } = readCodexContext(panel);
    if (managed) {
      if (!context || context.closed || context.primaryThreadId !== source.expectedPrimaryThreadId) return "unavailable";
      if (context.displayedThreadId === context.primaryThreadId) return context.displayedRunning ? "running" : "idle";
      return "unknown";
    }
    if (panel.threadId !== source.expectedPrimaryThreadId || getTerminalSessionAgent(panel) !== "codex") return "unavailable";
    return panel.terminalState?.state === "agent_running" ? "running" : panel.terminalState?.state === "agent_idle" ? "idle" : "unknown";
  } catch { return "unavailable"; }
}
