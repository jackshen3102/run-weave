import { lazy, Suspense, useMemo } from "react";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { ClientMode } from "../../features/client-mode";
import {
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { TerminalPanelTargetBar } from "./terminal-panel-target-bar";
import { TerminalSurface } from "./terminal-surface";

const TerminalPreviewPanel = lazy(() =>
  import("./terminal-preview-panel").then((module) => ({
    default: module.TerminalPreviewPanel,
  })),
);

interface StagePanelCommands {
  onPanelWorkspaceChange: (workspace: TerminalPanelWorkspace) => void;
  onResizePanel: (
    terminalSessionId: string,
    panelId: string,
    direction: "left" | "right" | "up" | "down",
    cells: number,
  ) => void;
  onRefreshPanelWorkspace: (terminalSessionId: string) => void;
  onPanelSplitEnabledChange: (enabled: boolean) => void;
  onActiveAgentTeamRunChange: (active: boolean) => void;
}

interface TerminalWorkspaceStageProps {
  clientMode: ClientMode;
  panels: StagePanelCommands;
  showAgentTeamTool: boolean;
  onEditProject: () => void;
}

export function TerminalWorkspaceStage({
  clientMode,
  panels,
  showAgentTeamTool,
  onEditProject,
}: TerminalWorkspaceStageProps) {
  const { apiBase, token } = useTerminalRuntime();
  const projectsQuery = useTerminalProjectsQuery();
  const sessionsQuery = useTerminalSessionsQuery();
  const projects = projectsQuery.data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = sessionsQuery.data ?? EMPTY_TERMINAL_SESSIONS;
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const requestError = useTerminalWorkspaceStore((state) => state.requestError);
  const cachedSurfaceSessionIds = useTerminalWorkspaceStore(
    (state) => state.cachedSurfaceSessionIds,
  );
  const agentRecoveryRevisionBySessionId = useTerminalWorkspaceStore(
    (state) => state.agentRecoveryRevisionBySessionId,
  );
  const terminalStateBySessionId = useTerminalWorkspaceStore(
    (state) => state.terminalStateBySessionId,
  );
  const panelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.panelWorkspaceBySessionId,
  );
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);
  const previewWidthPx = useTerminalPreviewStore((state) => state.ui.widthPx);
  const previewExpanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const isMobileMonitor = clientMode === "mobile";
  const visibleSessions = useMemo(
    () =>
      activeProjectId
        ? sessions.filter((session) => session.projectId === activeProjectId)
        : [],
    [activeProjectId, sessions],
  );
  const activeSession =
    visibleSessions.find(
      (session) => session.terminalSessionId === activeSessionId,
    ) ?? null;
  const surfaceSessions = useMemo(() => {
    const ids = new Set(cachedSurfaceSessionIds);
    if (activeSession) ids.add(activeSession.terminalSessionId);
    return sessions.filter((session) => ids.has(session.terminalSessionId));
  }, [activeSession, cachedSurfaceSessionIds, sessions]);
  const activeProject =
    projects.find((project) => project.projectId === activeProjectId) ?? null;
  const panelSplitEnabled = activeSession?.panelSplitEnabled ?? false;
  const activePanelWorkspace = activeSession
    ? (panelWorkspaceBySessionId[activeSession.terminalSessionId] ?? null)
    : null;
  const previewReservedWidth = previewWidthPx
    ? `${previewWidthPx}px`
    : DEFAULT_TERMINAL_SIDECAR_WIDTH;
  const terminalLayoutVersion = isMobileMonitor
    ? "mobile"
    : `desktop:${previewOpen ? previewReservedWidth : "full"}:${panelSplitEnabled ? "panel-split" : "single"}`;
  const effectiveRequestError =
    requestError ??
    ((projectsQuery.error ?? sessionsQuery.error)
      ? String(projectsQuery.error ?? sessionsQuery.error)
      : null);
  const {
    onActiveAgentTeamRunChange,
    onPanelSplitEnabledChange,
    onPanelWorkspaceChange,
    onRefreshPanelWorkspace,
    onResizePanel,
  } = panels;
  return (
    <div className="min-h-0 flex-1">
      {effectiveRequestError ? (
        <p className="border-b border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
          {effectiveRequestError}
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
                      key={`${apiBase}:${session.terminalSessionId}:surface:${agentRecoveryRevisionBySessionId[session.terminalSessionId] ?? 0}`}
                    >
                      <TerminalSurface
                        active={isActive}
                        activeCommand={session.activeCommand}
                        clientMode={clientMode}
                        layoutVersion={terminalLayoutVersion}
                        sessionStatus={session.status}
                        terminalSessionId={session.terminalSessionId}
                        terminalState={
                          terminalStateBySessionId[session.terminalSessionId] ??
                          session.terminalState
                        }
                        paneWorkspace={
                          session.panelSplitEnabled
                            ? (panelWorkspaceBySessionId[
                                session.terminalSessionId
                              ] ?? null)
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
              activeProject={activeProject}
              activeSession={activeSession}
              showAgentTeamTool={showAgentTeamTool}
              widthPx={previewWidthPx}
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
                  activeProject={activeProject}
                  activeSession={activeSession}
                  showAgentTeamTool={showAgentTeamTool}
                  widthPx={previewWidthPx}
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
