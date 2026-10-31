import type { ConversationTarget } from '@runweave/shared/terminal/conversation';
import type { TerminalSessionManager } from '../terminal/manager/manager';
import type { AppServerHistoryGateway } from '../work-history/app-server-history-gateway';
import { resolveConversationTarget } from '../terminal/application/conversation';

/** Never restores a terminal or changes its active panel while resolving evidence. */
export async function resolveAnalysisConversation(
  manager: TerminalSessionManager, history: AppServerHistoryGateway,
  provider: string, threadID: string,
): Promise<ConversationTarget | null> {
  const detail = await history.getThreadReference(threadID);
  if (!detail) return null;
  const { thread } = detail;
  if (thread.threadId !== threadID || thread.agent !== provider || !thread.terminalSessionId ||
      thread.identityStatus !== 'resolved') return null;
  try {
    const { target } = resolveConversationTarget(manager, thread.terminalSessionId, thread.terminalPanelId ?? undefined);
    return target?.threadId === threadID && target.provider === provider ? target : null;
  } catch { return null; }
}
