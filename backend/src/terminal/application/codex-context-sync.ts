import type { TerminalEventService } from "../state/terminal-event-service";
import { recordPanelEvent, syncSinglePanelMetadataToSession } from "./panel-metadata";
import type { TerminalPanelRecord, TerminalSessionManager } from "../manager/manager";
import { readCodexContext } from "../runtime/codex-context";
import { invalidateTerminalInput } from "../runtime/input-admission";

/** Called by the existing pane reconciliation loop; no second runtime or polling owner. */
export async function syncCodexContext(manager: TerminalSessionManager, panel: TerminalPanelRecord): Promise<boolean> {
  const observed = readCodexContext(panel);
  const generation = manager.getPanelAgentOperationGeneration(panel.terminalSessionId, panel.id);
  const context = generation && observed.context?.operationId !== generation.operationId ? null : observed.context;
  if (!observed.managed) {
    const changed = panel.codexContext !== undefined;
    delete panel.codexContext;
    return changed;
  }
  let changed = JSON.stringify(panel.codexContext) !== JSON.stringify(context);
  panel.codexContext = context;
  const session = manager.getSession(panel.terminalSessionId);
  if (changed && session) invalidateTerminalInput(session);
  // The launcher's foreground process can be Node before any startup hook is accepted.
  // Only a live native observation from this operation may identify that wrapper.
  if (session && context?.primaryThreadId && !context.closed && panel.activeCommand === "node") {
    const terminalState = { state: context.displayedThreadId === context.primaryThreadId && context.displayedRunning ? "agent_running" as const : "agent_idle" as const, agent: "codex" as const };
    await manager.upsertPanel({ ...panel, activeCommand: "codex", terminalState });
    await manager.updateSessionMetadata(session.id, { cwd: session.cwd, activeCommand: "codex" });
    changed = true;
  }
  if (context?.primaryThreadId && panel.lastThreadId !== context.primaryThreadId) {
    await manager.updatePanelThreadId(panel.id, context.primaryThreadId, "codex", context.operationId);
    await manager.updatePanelLastThread(panel.id, context.primaryThreadId, context.displayedThreadId === context.primaryThreadId && context.displayedRunning ? "running" : "idle", new Date(), "codex", context.operationId);
  }
  return changed;
}

export async function observeCodexPane(manager: TerminalSessionManager, events: TerminalEventService, sessionId: string, paneId: string): Promise<void> {
  const session = manager.getSession(sessionId);
  const panels = manager.listPanels(sessionId);
  const panel = panels.find((candidate) => candidate.tmuxPaneId === paneId);
  if (!session || !panel || !(await syncCodexContext(manager, panel))) return;
  if (panels.filter((candidate) => candidate.status === "running").length === 1)
    await syncSinglePanelMetadataToSession(manager, session, manager.getPanel(panel.id) ?? panel);
  recordPanelEvent(manager, events, session, "terminal_panel_updated", {});
}
