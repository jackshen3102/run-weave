import { createHash } from "node:crypto";
import {
  budgetHandoff,
  HandoffBudgetError,
} from "@runweave/shared/terminal/handoff-budgeter";
import type { TerminalConversationResponse } from "@runweave/shared/terminal/conversation";
import { TerminalPanelError } from "./panel-common";

// Older App Servers return their ordinary visible projection.
export function handoffSnapshot(
  conversation: TerminalConversationResponse,
  provider: string,
  threadId: string,
  cwd: string,
) {
  if (conversation.partial)
    throw new TerminalPanelError(409, "来源仅有部分记录，无法确认首条任务");
  if (conversation.handoff) return conversation.handoff;
  try {
    return {
      ...budgetHandoff(conversation.turns, provider, threadId, cwd),
      revision: createHash("sha256")
        .update(JSON.stringify(conversation.turns))
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof HandoffBudgetError)
      throw new TerminalPanelError(error.status, error.message);
    throw error;
  }
}
