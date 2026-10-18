import { useHandoffLinks } from "../../../features/terminal/handoff/use-context-link";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { Plus } from "lucide-react";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { SortableTabs, type SortableTabRenderProps } from "../../ui/sortable-tabs";
import { TerminalSessionTab } from "./session-tab";

function getWorkspacePanelCount(
  workspace: { panels?: unknown[] } | null | undefined,
): number | null {
  return Array.isArray(workspace?.panels) ? workspace.panels.length : null;
}

interface TerminalSessionTabStripProps {
  visibleSessions: TerminalSessionListItem[];
  isMobileMonitor: boolean;
  loading: boolean;
  onReorderSessions: (fromIndex: number, toIndex: number) => void;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onRequestEditAlias: (session: TerminalSessionListItem) => void;
  onPanelSplitEnabledChange: (
    terminalSessionId: string,
    enabled: boolean,
  ) => void;
  onRequestCreateSession: () => void;
}

export function TerminalSessionTabStrip({
  visibleSessions,
  isMobileMonitor,
  loading,
  onReorderSessions,
  onSelectSession,
  onRequestCloseSession,
  onRequestEditAlias,
  onPanelSplitEnabledChange,
  onRequestCreateSession,
}: TerminalSessionTabStripProps) {
  const { links } = useHandoffLinks();
  const panelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.panelWorkspaceBySessionId,
  );
  return (
    <div className="flex h-[26px] items-stretch border-b border-slate-800">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SortableTabs
          items={visibleSessions}
          getItemId={(session) => session.terminalSessionId}
          onReorder={onReorderSessions}
          className="flex min-w-0 items-stretch"
          renderTab={(
            session: TerminalSessionListItem,
            sortProps: SortableTabRenderProps,
          ) => {
            return (
              <TerminalSessionTab
                session={session}
                hasContextLink={links.some(link => {
                  if (link.target.terminalSessionId !== session.terminalSessionId || link.projectId !== session.projectId) return false;
                  const workspace = panelWorkspaceBySessionId[session.terminalSessionId];
                  const panel = workspace?.panels.find(item => item.panelId === link.target.panelId);
                  if (!link.target.panelId) return session.lastThreadId === link.target.threadId;
                  // Session metadata describes the active native panel even when
                  // the single-panel workspace has not loaded thread metadata.
                  if (link.target.panelId === session.activePanelId)
                    return session.lastThreadId === link.target.threadId;
                  return panel?.lastThreadId === link.target.threadId;
                })}
                isDragging={sortProps.isDragging}
                isMobileMonitor={isMobileMonitor}
                panelCount={
                  getWorkspacePanelCount(
                    panelWorkspaceBySessionId[session.terminalSessionId],
                  ) ??
                  session.panelCount ??
                  1
                }
                onSelectSession={onSelectSession}
                onRequestCloseSession={onRequestCloseSession}
                onRequestEditAlias={onRequestEditAlias}
                onPanelSplitEnabledChange={(enabled) => {
                  onPanelSplitEnabledChange(session.terminalSessionId, enabled);
                }}
              />
            );
          }}
        />
        {!isMobileMonitor ? (
          <button
            type="button"
            disabled={loading}
            className="flex h-full w-10 shrink-0 items-center justify-center border-r border-slate-800 text-slate-300 hover:bg-slate-900/45 hover:text-slate-100 disabled:opacity-40"
            aria-label="New Terminal"
            title="New Terminal"
            onClick={onRequestCreateSession}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
