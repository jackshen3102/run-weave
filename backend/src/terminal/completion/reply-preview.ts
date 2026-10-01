import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import { formatThreadPreviewText } from "@runweave/shared/app-server-events";
import type {
  TerminalPanelRecord,
  TerminalSessionRecord,
} from "../manager/manager";
import { getTerminalSessionAgent } from "../state/terminal-state-service";

type ReplyOwner = TerminalSessionRecord | TerminalPanelRecord;
type ThreadIdentity = { id: string; provider: TerminalAgentKind };

export function resolveReplyThread(owner: ReplyOwner): ThreadIdentity | null {
  const agent = getTerminalSessionAgent(owner);
  if (!agent) return null;
  if (owner.threadId) {
    const provider = owner.threadProvider ?? "codex";
    return provider === agent ? { id: owner.threadId, provider } : null;
  }
  return owner.lastThreadId && owner.lastThreadProvider === agent
    ? { id: owner.lastThreadId, provider: agent }
    : null;
}

export function formatReplyPreview(
  reply: string | null | undefined,
): string | null {
  return formatThreadPreviewText(reply);
}
