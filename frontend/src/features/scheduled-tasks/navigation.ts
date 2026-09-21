import { useLocation, useNavigate } from "react-router-dom";
import { useMemoizedFn } from "ahooks";
import { useTerminalRuntime } from "../terminal/queries/provider";
import { useTerminalWorkspaceStore } from "../terminal/state/workspace-store";
import { loadRecentTerminalSelection } from "../terminal/input/recent-selection";
import {
  setTerminalNavigation,
  type TerminalNavigationSelection,
} from "../terminal/state/navigation";

interface TaskNavigationState {
  scope: string;
  workspace: TerminalNavigationSelection;
}
export function useEnterScheduledTasks() {
  const { scope } = useTerminalRuntime();
  const navigate = useNavigate();
  return useMemoizedFn((path = "/scheduled-tasks") => {
    const state = useTerminalWorkspaceStore.getState();
    navigate(path, {
      state: {
        scope,
        workspace: {
          parentProjectId: state.activeParentProjectId,
          projectId: state.activeProjectId,
          terminalSessionId: state.activeSessionId,
          panelId: state.activeSessionId
            ? state.activePanelIdBySessionId[state.activeSessionId]
            : undefined,
        },
      } satisfies TaskNavigationState,
    });
  });
}
export function useTaskNavigation() {
  const { scope } = useTerminalRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as TaskNavigationState | null;
  const recent = loadRecentTerminalSelection(scope);
  const workspace: TerminalNavigationSelection =
    state?.scope === scope
      ? state.workspace
      : {
          parentProjectId: recent?.projectId ?? null,
          projectId: recent
            ? (recent.contextProjectIdByParentProjectId[recent.projectId] ??
              recent.projectId)
            : null,
          terminalSessionId: recent?.terminalSessionId ?? null,
        };
  const go = useMemoizedFn((path: string) =>
    navigate(path, {
      state: { scope, workspace } satisfies TaskNavigationState,
    }),
  );
  const back = useMemoizedFn(() => {
    setTerminalNavigation(scope, workspace);
    navigate(
      workspace.terminalSessionId
        ? `/terminal/${encodeURIComponent(workspace.terminalSessionId)}`
        : "/terminal",
    );
  });
  return { workspace, go, back };
}
