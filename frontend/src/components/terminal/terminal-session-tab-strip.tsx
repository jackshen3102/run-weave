import type {
  TerminalPanelWorkspace,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import { Plus } from "lucide-react";
import {
  SortableTabs,
  type SortableTabRenderProps,
} from "../ui/sortable-tabs";
import {
  canOpenAgentTeamForSession,
  TerminalSessionTab,
} from "./terminal-session-tab";

function getWorkspacePanelCount(
  workspace: { panels?: unknown[] } | null | undefined,
): number | null {
  return Array.isArray(workspace?.panels) ? workspace.panels.length : null;
}

interface TerminalSessionTabStripProps {
  visibleSessions: TerminalSessionListItem[];
  activeSession: TerminalSessionListItem | null;
  isMobileMonitor: boolean;
  loading: boolean;
  bellMarkers: Record<string, boolean | undefined>;
  completionMarkers: Record<string, boolean | undefined>;
  terminalStateBySessionId: Record<string, TerminalState | undefined>;
  panelWorkspaceBySessionId: Record<
    string,
    TerminalPanelWorkspace | null | undefined
  >;
  onReorderSessions: (fromIndex: number, toIndex: number) => void;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onRequestEditAlias: (session: TerminalSessionListItem) => void;
  onPanelSplitEnabledChange: (
    terminalSessionId: string,
    enabled: boolean,
  ) => void;
  onRequestAgentTeam: (terminalSessionId: string) => void;
  onRequestCreateSession: () => void;
}

export function TerminalSessionTabStrip({
  visibleSessions,
  activeSession,
  isMobileMonitor,
  loading,
  bellMarkers,
  completionMarkers,
  terminalStateBySessionId,
  panelWorkspaceBySessionId,
  onReorderSessions,
  onSelectSession,
  onRequestCloseSession,
  onRequestEditAlias,
  onPanelSplitEnabledChange,
  onRequestAgentTeam,
  onRequestCreateSession,
}: TerminalSessionTabStripProps) {
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
            const isActive =
              session.terminalSessionId === activeSession?.terminalSessionId;
            const hasBell =
              !isActive && Boolean(bellMarkers[session.terminalSessionId]);
            const hasCompletion = Boolean(
              completionMarkers[session.terminalSessionId],
            );
            return (
              <TerminalSessionTab
                session={session}
                isActive={isActive}
                isDragging={sortProps.isDragging}
                isMobileMonitor={isMobileMonitor}
                hasBell={hasBell}
                hasCompletion={hasCompletion}
                terminalState={terminalStateBySessionId[session.terminalSessionId]}
                panelSplitEnabled={session.panelSplitEnabled}
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
                agentTeamAvailable={canOpenAgentTeamForSession(session)}
                onRequestAgentTeam={onRequestAgentTeam}
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
