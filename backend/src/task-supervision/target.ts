import type { SupervisionTarget } from "@runweave/shared/task-supervision";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { resolveReplyThread } from "../terminal/completion/reply-preview";
import { getTerminalSessionAgent } from "../terminal/state/terminal-state-service";
import { SupervisionError } from "./errors";
export function resolveSupervisionTarget(
  manager: TerminalSessionManager,
  terminalSessionId: string,
  panelId?: string | null,
): { target: SupervisionTarget; root: string } {
  const session = manager.getSession(terminalSessionId);
  const activeId = manager.getPanelWorkspace(terminalSessionId)?.activePanelId;
  const panels = manager.listPanels(terminalSessionId);
  const panel = panelId
    ? manager.getPanel(panelId)
    : (panels.find((p) => p.id === activeId && getTerminalSessionAgent(p)) ??
      panels.find((p) => p.status === "running" && getTerminalSessionAgent(p)));
  if (!session || !panel || panel.terminalSessionId !== terminalSessionId)
    throw new SupervisionError("当前终端没有 Agent，请先启动 Agent。", 422);
  const agent = getTerminalSessionAgent(panel);
  const identity = resolveReplyThread(panel);
  const generation = manager.getPanelAgentOperationGeneration(
    terminalSessionId,
    panel.id,
  );
  if (!agent || session.status !== "running" || panel.status !== "running")
    throw new SupervisionError("当前终端没有 Agent，请先启动 Agent。", 422);
  return {
    target: {
      terminalSessionId,
      panelId: panel.id,
      threadId: identity?.id ?? "",
      executorGeneration: generation?.operationId ?? `${agent}:${panel.id}`,
    },
    root: manager.getProject(session.projectId)?.path ?? panel.cwd,
  };
}
