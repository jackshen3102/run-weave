import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import { create } from "zustand";
import type { ConversationTarget } from "@runweave/shared/terminal/conversation";
import type { TaskHandoffEvidence } from "@runweave/shared/task-handoff";
import { getTerminalConversation } from "../../../services/terminal/conversation";
import { getTerminalSession } from "../../../services/terminal/sessions";
import { setTerminalNavigation } from "../state/navigation";
import { useTerminalWorkspaceStore } from "../state/workspace-store";
import { useTerminalPreviewStore } from "../preview/store";

export type ConversationLocation = {
  requestId: string;
  scope: string;
  target: ConversationTarget;
  messageId: string;
};
export const useConversationLocation = create<{
  pending: ConversationLocation | null;
  set: (request: ConversationLocation) => void;
  consume: (requestId: string) => void;
}>((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
  consume: (requestId) =>
    set((state) =>
      state.pending?.requestId === requestId ? { pending: null } : state,
    ),
}));

/** Read-only verification before selecting an existing terminal. Never starts/resumes an Agent. */
export async function openHandoffConversation({
  origin,
  projectId,
  runtime,
  navigate,
  isCurrent,
}: {
  origin: NonNullable<TaskHandoffEvidence["origin"]>;
  projectId: string;
  runtime: { scope: string; apiBase: string; token: string };
  navigate: (path: string) => void;
  isCurrent: () => boolean;
}) {
  const before = useTerminalWorkspaceStore.getState().activeSessionId;
  const controller = new AbortController();
  const target = origin.target;
  const [conversation, session] = await Promise.all([
    getTerminalConversation(
      runtime.apiBase,
      runtime.token,
      target.terminalSessionId,
      { panelId: target.panelId, expectedThreadId: target.threadId },
      controller.signal,
    ),
    getTerminalSession(
      runtime.apiBase,
      runtime.token,
      target.terminalSessionId,
    ),
  ]);
  if (
    !isCurrent() ||
    useTerminalWorkspaceStore.getState().activeSessionId !== before
  )
    throw new Error("当前会话或账号已切换，请重新打开来源");
  if (
    session.projectId !== projectId ||
    !conversation.target ||
    conversation.target.provider !== "codex" ||
    conversation.target.threadId !== target.threadId ||
    conversation.target.panelId !== target.panelId ||
    conversation.target.terminalSessionId !== target.terminalSessionId ||
    conversation.availability !== "available"
  )
    throw new Error("原会话当前不可用；已保存的来源记录仍可查看");
  if (
    origin.messageId &&
    !conversation.turns.some((turn) =>
      turn.messages.some((message) => message.id === origin.messageId),
    )
  )
    throw new Error("无法定位该条回复；请查看已有来源摘录");
  useConversationLocation.getState().set({
      requestId: crypto.randomUUID(),
      scope: runtime.scope,
      target: conversation.target,
      messageId: origin.messageId ?? "",
    });
  setTerminalNavigation(runtime.scope, {
    parentProjectId: resolveTerminalParentProjectId(projectId),
    projectId,
    terminalSessionId: target.terminalSessionId,
    ...(target.panelId ? { panelId: target.panelId } : {}),
  });
  const workspace = useTerminalWorkspaceStore.getState();
  workspace.selectProjectContext(
    resolveTerminalParentProjectId(projectId),
    projectId,
    target.terminalSessionId,
  );
  if (target.panelId)
    workspace.setActivePanelIdBySessionId((old) => ({
      ...old,
      [target.terminalSessionId]: target.panelId!,
    }));
  useTerminalPreviewStore.getState().openConversation({
    scope: runtime.scope,
    sessionId: target.terminalSessionId,
    panelId: target.panelId,
  });
  navigate(`/terminal/${encodeURIComponent(target.terminalSessionId)}`);
}
