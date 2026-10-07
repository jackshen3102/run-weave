import type { SupervisionTarget } from "@runweave/shared/task-supervision";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { resolveReplyThread } from "../terminal/completion/reply-preview";
import { SupervisionError } from "./errors";
export function resolveSupervisionTarget(
  manager: TerminalSessionManager,
  terminalSessionId: string,
  panelId?: string | null,
): { target: SupervisionTarget; root: string } {
  const session = manager.getSession(terminalSessionId);
  const id =
    panelId ?? manager.getPanelWorkspace(terminalSessionId)?.activePanelId;
  const panel = id ? manager.getPanel(id) : null;
  if (!session || !panel || panel.terminalSessionId !== terminalSessionId)
    throw new SupervisionError("当前终端面板不存在。", 422);
  const identity = resolveReplyThread(panel);
  const generation = manager.getPanelAgentOperationGeneration(
    terminalSessionId,
    panel.id,
  );
  if (
    identity?.provider !== "codex" ||
    generation?.provider !== "codex" ||
    panel.agentTeamRunId ||
    session.status !== "running" ||
    panel.status !== "running"
  )
    throw new SupervisionError(
      "仅支持有明确执行器身份的普通 Codex 终端，请从终端 Agent 入口启动 Codex。",
      422,
    );
  return {
    target: {
      terminalSessionId,
      panelId: panel.id,
      threadId: identity.id,
      executorGeneration: generation.operationId,
    },
    root: manager.getProject(session.projectId)?.path ?? panel.cwd,
  };
}

/** SessionStart can precede the asynchronous metadata projection, but never a new generation. */
export function acceptsStartingHook(
  manager: TerminalSessionManager,
  target: SupervisionTarget,
) {
  return (
    manager.matchesPanelAgentOperationGeneration?.(
      target.terminalSessionId,
      target.panelId,
      target.executorGeneration,
      "codex",
    ) === true
  );
}
