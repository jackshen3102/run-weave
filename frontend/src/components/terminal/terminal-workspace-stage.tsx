import { lazy, Suspense } from "react";
import type {
  TerminalPanelWorkspace,
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import type { ClientMode } from "../../features/client-mode";
import { DEFAULT_TERMINAL_SIDECAR_WIDTH } from "../../features/terminal/preview-store";
import { TerminalPanelTargetBar } from "./terminal-panel-target-bar";
import { TerminalSurface } from "./terminal-surface";

const TerminalPreviewPanel = lazy(() =>
  import("./terminal-preview-panel").then((module) => ({
    default: module.TerminalPreviewPanel,
  })),
);

interface TerminalWorkspaceStageProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  isMobileMonitor: boolean;
  requestError: string | null;
  activeSession: TerminalSessionListItem | null;
  visibleSessions: TerminalSessionListItem[];
  surfaceSessions: TerminalSessionListItem[];
  panelSplitEnabled: boolean;
  activePanelWorkspace: TerminalPanelWorkspace | null;
  terminalLayoutVersion: string;
  terminalStateBySessionId: Record<string, TerminalState | undefined>;
  panelWorkspaceBySessionId: Record<
    string,
    TerminalPanelWorkspace | null | undefined
  >;
  previewOpen: boolean;
  previewExpanded: boolean;
  previewWidthPx: number | undefined;
  previewReservedWidth: string;
  activeProject: TerminalProjectListItem | null;
  showAgentTeamTool: boolean;
  sessions: TerminalSessionListItem[];
  onAuthExpired?: () => void;
  onPanelWorkspaceChange: (workspace: TerminalPanelWorkspace) => void;
  onResizePanel: (
    terminalSessionId: string,
    panelId: string,
    direction: "left" | "right" | "up" | "down",
    cells: number,
  ) => void;
  onRefreshPanelWorkspace: (terminalSessionId: string) => void;
  onSelectSession: (terminalSessionId: string) => void;
  onPanelSplitEnabledChange: (enabled: boolean) => void;
  onActiveAgentTeamRunChange: (active: boolean) => void;
  onEditProject: () => void;
}

export function TerminalWorkspaceStage({
  apiBase,
  token,
  clientMode,
  isMobileMonitor,
  requestError,
  activeSession,
  visibleSessions,
  surfaceSessions,
  panelSplitEnabled,
  activePanelWorkspace,
  terminalLayoutVersion,
  terminalStateBySessionId,
  panelWorkspaceBySessionId,
  previewOpen,
  previewExpanded,
  previewWidthPx,
  previewReservedWidth,
  activeProject,
  showAgentTeamTool,
  sessions,
  onAuthExpired,
  onPanelWorkspaceChange,
  onResizePanel,
  onRefreshPanelWorkspace,
  onSelectSession,
  onPanelSplitEnabledChange,
  onActiveAgentTeamRunChange,
  onEditProject,
}: TerminalWorkspaceStageProps) {
  return (
    <div className="min-h-0 flex-1">
      {requestError ? (
        <p className="border-b border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
          {requestError}
        </p>
      ) : null}
      <div className="relative flex h-full min-h-0">
        <div className="flex min-h-0 flex-1 flex-col">
          {activeSession && !isMobileMonitor && panelSplitEnabled ? (
            <TerminalPanelTargetBar
              apiBase={apiBase}
              token={token}
              activeSession={activeSession}
              workspace={activePanelWorkspace}
              onWorkspaceChange={onPanelWorkspaceChange}
            />
          ) : null}
          <div className="relative min-h-0 flex-1">
            {visibleSessions.length > 0 ? (
              <>
                {surfaceSessions.map((session) => {
                  const isActive =
                    session.terminalSessionId ===
                    activeSession?.terminalSessionId;

                  return (
                    <div
                      aria-hidden={!isActive}
                      className={[
                        "absolute top-0 h-full w-full",
                        isActive
                          ? "left-0"
                          : "-left-[9999em] pointer-events-none",
                      ].join(" ")}
                      key={`${apiBase}:${session.terminalSessionId}:surface`}
                    >
                      <TerminalSurface
                        active={isActive}
                        activeCommand={session.activeCommand}
                        apiBase={apiBase}
                        clientMode={clientMode}
                        layoutVersion={terminalLayoutVersion}
                        sessionStatus={session.status}
                        terminalSessionId={session.terminalSessionId}
                        terminalState={
                          terminalStateBySessionId[
                            session.terminalSessionId
                          ] ?? session.terminalState
                        }
                        token={token}
                        paneWorkspace={
                          session.panelSplitEnabled
                            ? panelWorkspaceBySessionId[
                                session.terminalSessionId
                              ] ?? null
                            : null
                        }
                        onResizePane={
                          !isMobileMonitor && session.panelSplitEnabled
                            ? (panelId, direction, cells) => {
                                onResizePanel(
                                  session.terminalSessionId,
                                  panelId,
                                  direction,
                                  cells,
                                );
                              }
                            : undefined
                        }
                        onAuthExpired={onAuthExpired}
                        onViewportResize={
                          session.panelSplitEnabled
                            ? () => {
                                onRefreshPanelWorkspace(
                                  session.terminalSessionId,
                                );
                              }
                            : undefined
                        }
                      />
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-sm text-slate-400">
                No terminal tab yet. Create one to start.
              </div>
            )}
          </div>
        </div>
        {previewOpen && !previewExpanded && !isMobileMonitor ? (
          <Suspense
            fallback={
              <aside
                className="flex h-full shrink-0 items-center justify-center border-l border-slate-800 bg-slate-950 text-sm text-slate-400"
                style={{ width: DEFAULT_TERMINAL_SIDECAR_WIDTH }}
              >
                Loading preview...
              </aside>
            }
          >
            <TerminalPreviewPanel
              apiBase={apiBase}
              token={token}
              activeProject={activeProject}
              activeSession={activeSession}
              showAgentTeamTool={showAgentTeamTool}
              widthPx={previewWidthPx}
              onAuthExpired={onAuthExpired}
              sessions={sessions}
              onSelectSession={onSelectSession}
              onPanelSplitEnabledChange={onPanelSplitEnabledChange}
              onActiveAgentTeamRunChange={onActiveAgentTeamRunChange}
              onEditProject={onEditProject}
            />
          </Suspense>
        ) : null}
        {previewOpen && previewExpanded && !isMobileMonitor ? (
          <>
            <div
              aria-hidden="true"
              className="min-h-0 shrink-0"
              style={{ width: previewReservedWidth }}
            />
            <div className="absolute inset-0 z-20">
              <Suspense
                fallback={
                  <aside className="flex h-full w-full items-center justify-center bg-slate-950 text-sm text-slate-400">
                    Loading preview...
                  </aside>
                }
              >
                <TerminalPreviewPanel
                  apiBase={apiBase}
                  token={token}
                  activeProject={activeProject}
                  activeSession={activeSession}
                  showAgentTeamTool={showAgentTeamTool}
                  widthPx={previewWidthPx}
                  onAuthExpired={onAuthExpired}
                  sessions={sessions}
                  onSelectSession={onSelectSession}
                  onPanelSplitEnabledChange={onPanelSplitEnabledChange}
                  onActiveAgentTeamRunChange={onActiveAgentTeamRunChange}
                  onEditProject={onEditProject}
                />
              </Suspense>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
