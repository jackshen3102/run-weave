import { readCodexContext } from "../terminal/runtime/codex-context";
import type { SupervisionTarget } from "@runweave/shared/task-supervision";
import type { TerminalSessionManager, TerminalSessionRecord, TerminalPanelRecord } from "../terminal/manager/manager";
import { resolveReplyThread } from "../terminal/completion/reply-preview";
import { getTerminalSessionAgent } from "../terminal/state/terminal-state-service";
import { SupervisionError } from "./errors";
export function resolveSupervisionTarget(
  manager: TerminalSessionManager,
  terminalSessionId: string,
  panelId?: string | null,
): { target: SupervisionTarget; root: string; session: TerminalSessionRecord; owner: TerminalSessionRecord | TerminalPanelRecord; panel: TerminalPanelRecord | undefined } {
  const session = manager.getSession(terminalSessionId);
  if (!session) throw new SupervisionError("当前终端没有 Agent，请先启动 Agent。", 422);
  const pty = session.runtimeKind !== "tmux";
  if (pty && panelId && panelId !== "default")
    throw new SupervisionError("原终端面板已变化，请重新读取。", 409);
  const activeId = manager.getPanelWorkspace(terminalSessionId)?.activePanelId;
  const panels = manager.listPanels(terminalSessionId);
  const panel = pty ? undefined : panelId
    ? manager.getPanel(panelId)
    : (panels.find((p) => p.id === activeId && getTerminalSessionAgent(p)) ??
      panels.find((p) => p.status === "running" && getTerminalSessionAgent(p)));
  if (!pty && (!panel || panel.terminalSessionId !== terminalSessionId))
    throw new SupervisionError("当前终端没有 Agent，请先启动 Agent。", 422);
  const owner = panel ?? session;
  const targetPanelId = panel?.id ?? "default";
  const agent = getTerminalSessionAgent(owner);
  const observed = readCodexContext({ terminalSessionId, id: targetPanelId });
  if (agent === "codex" && observed.managed && (!observed.context?.primaryThreadId || observed.context.closed))
    throw new SupervisionError("Codex 主会话身份尚未就绪，请在原终端确认后重试。", 409);
  const identity = agent === "codex" && observed.context?.primaryThreadId
    ? { id: observed.context.primaryThreadId, provider: "codex" as const }
    : resolveReplyThread(owner);
  const generation = manager.getPanelAgentOperationGeneration(
    terminalSessionId,
    targetPanelId,
  );
  if (!agent || session.status !== "running" || owner.status !== "running")
    throw new SupervisionError("当前终端没有 Agent，请先启动 Agent。", 422);
  return {
    session, owner, panel,
    target: {
      terminalSessionId,
      panelId: targetPanelId,
      threadId: identity?.id ?? "",
      executorGeneration: pty
        ? `${generation?.operationId ?? agent}:${session.id}:${session.ptyHost ? `${session.ptyHost.hostInstanceId}:${session.ptyHost.sessionInstanceId}` : session.createdAt.toISOString()}`
        : generation?.operationId ?? `${agent}:${targetPanelId}`,
    },
    root: manager.getProject(session.projectId)?.path ?? owner.cwd,
  };
}
