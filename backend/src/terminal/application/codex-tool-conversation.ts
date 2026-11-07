import type { TerminalSessionManager, TerminalPanelRecord } from "../manager/manager";
import { readCodexContext } from "../runtime/codex-context";
import { isCodexConversationThread } from "../runtime/codex-thread-identity";
import { getTerminalSessionAgent } from "../state/terminal-state-service";

/** Repair a legacy association from a real primary tool hook, without synthesizing a prompt. */
export async function recoverCodexToolConversation(
  manager: TerminalSessionManager, panel: TerminalPanelRecord,
  threadId: string | undefined, operationId: string | undefined,
): Promise<void> {
  if (!threadId || panel.threadId || panel.lastThreadId === threadId ||
      getTerminalSessionAgent(panel) !== "codex" || readCodexContext(panel).managed) return;
  const previous = panel.lastThreadId;
  if (!previous || await isCodexConversationThread(previous) !== false ||
      await isCodexConversationThread(threadId) !== true) return;
  const current = manager.getPanel(panel.id);
  const generation = manager.getPanelAgentOperationGeneration(panel.terminalSessionId, panel.id);
  if (!current || current.status !== "running" || current.threadId || current.lastThreadId !== previous ||
      getTerminalSessionAgent(current) !== "codex" ||
      (generation && generation.operationId !== operationId)) return;
  const at = new Date();
  await manager.updatePanelLastThread(panel.id, threadId, "running", at, "codex", operationId);
  const panels = manager.listPanels(panel.terminalSessionId).filter((value) => value.status === "running");
  if (panels.length === 1) {
    await manager.updateSessionLastThread(panel.terminalSessionId, threadId, "running", at, "codex");
  }
}
