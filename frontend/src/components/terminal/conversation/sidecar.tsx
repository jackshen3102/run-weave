import { useMemoizedFn } from "ahooks";
import { useTerminalPreviewStore, type TerminalSidecarTool } from "../../../features/terminal/preview/store";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { TerminalConversationPanel } from "./panel";

export function TerminalConversationSidecar({ projectId, title, sessionId, panelId }: {
  projectId: string; title: string; sessionId: string | null; panelId: string | null;
}) {
  const target = useTerminalPreviewStore((state) => state.conversationTarget);
  const { scope } = useTerminalRuntime();
  return target && target.scope === scope && target.sessionId === sessionId && target.panelId === panelId
    ? <TerminalConversationPanel key={JSON.stringify([scope, target.sessionId, target.panelId])} sessionId={target.sessionId} panelId={target.panelId}
    projectId={projectId} title={title} /> : null;
}

export function useConversationTool(sessionId: string | null, panelId: string | null) {
  const { scope } = useTerminalRuntime();
  return useMemoizedFn((tool: TerminalSidecarTool) => {
    const store = useTerminalPreviewStore.getState();
    if (tool === "conversation" && sessionId) store.openConversation({ scope, sessionId, panelId });
    else store.setActiveTool(tool);
  });
}
