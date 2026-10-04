import type { ConversationTarget, TerminalConversationResponse } from "@runweave/shared/terminal/conversation";
import { discoverAppServer } from "@runweave/config-node/app-server/discovery";
import { AppServerClient, AppServerConversationError } from "../../app-server/client";
import type { TerminalSessionManager, TerminalSessionRecord, TerminalPanelRecord } from "../manager/manager";
import { getTerminalSessionAgent } from "../state/terminal-state-service";

export class TerminalConversationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function changed(): never {
  throw new TerminalConversationError(409, "CONVERSATION_TARGET_CHANGED", "会话已变化，请关闭后重新打开阅读页");
}

/** Only observes registered owners. Does not restore tmux, synchronize focus or start an Agent. */
export function resolveConversationTarget(manager: TerminalSessionManager, sessionId: string, panelId?: string): {
  target: ConversationTarget | null; agent: string | null;
} {
  const session = manager.getSession(sessionId);
  if (!session) throw new TerminalConversationError(404, "TERMINAL_NOT_FOUND", "终端不存在");
  const workspace = manager.getPanelWorkspace(sessionId);
  const selectedPanelId = panelId ?? workspace?.activePanelId;
  let owner: TerminalSessionRecord | TerminalPanelRecord = session;
  if (selectedPanelId) {
    const panel = manager.getPanel(selectedPanelId);
    if (!panel || panel.terminalSessionId !== sessionId)
      throw new TerminalConversationError(404, "PANEL_NOT_FOUND", "终端面板不存在");
    owner = panel;
  } else if (manager.listPanels(sessionId).length) {
    throw new TerminalConversationError(409, "CONVERSATION_TARGET_CHANGED", "请先选择终端面板");
  }
  const agent = getTerminalSessionAgent(owner);
  const threadId = owner.threadId ?? owner.lastThreadId;
  const provider = owner.threadId ? owner.threadProvider ?? "codex" : owner.lastThreadProvider;
  if (threadId && provider && agent && provider !== agent) changed();
  return { agent, target: threadId && provider ? {
    terminalSessionId: sessionId, panelId: selectedPanelId ?? null, threadId, provider,
  } : null };
}

export async function readTerminalConversation(
  manager: TerminalSessionManager, sessionId: string,
  query: { panelId?: string; expectedThreadId?: string }, signal: AbortSignal,
): Promise<TerminalConversationResponse> {
  const before = resolveConversationTarget(manager, sessionId, query.panelId);
  if (query.expectedThreadId && before.target?.threadId !== query.expectedThreadId) changed();
  const target = before.target;
  if (!target || !["codex", "pi"].includes(target.provider)) return {
    target, availability: (target || (before.agent && !["codex", "pi"].includes(before.agent)))
      ? "provider_unsupported" : "no_thread",
    readAt: new Date().toISOString(), partial: false, turns: [],
  };
  try {
    const connection = await discoverAppServer({ env: process.env });
    if (!connection) throw new Error("App Server unavailable");
    const response = await new AppServerClient(connection).getConversation(target.threadId,
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
    const after = resolveConversationTarget(manager, sessionId, query.panelId);
    if (JSON.stringify(before) !== JSON.stringify(after) || response.threadId !== target.threadId ||
      response.provider !== target.provider) changed();
    return { target, availability: response.availability, readAt: response.readAt,
      partial: response.partial, turns: response.turns };
  } catch (error) {
    if (error instanceof TerminalConversationError) throw error;
    if (error instanceof AppServerConversationError && error.status === 413)
      throw new TerminalConversationError(413, "CONVERSATION_TOO_LARGE", "会话记录超过读取上限");
    throw new TerminalConversationError(503, "CONVERSATION_UNAVAILABLE", "会话读取暂不可用，请手动重试");
  }
}
