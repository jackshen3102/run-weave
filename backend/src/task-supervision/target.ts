import { readCodexContext } from "../terminal/runtime/codex-context";
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
  const observed = readCodexContext(panel);
  if (agent === "codex" && observed.managed && (!observed.context?.primaryThreadId || observed.context.closed))
    throw new SupervisionError("Codex 主会话身份尚未就绪，请在原终端确认后重试。", 409);
  const identity = agent === "codex" && observed.context?.primaryThreadId
    ? { id: observed.context.primaryThreadId, provider: "codex" as const }
    : resolveReplyThread(panel);
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
