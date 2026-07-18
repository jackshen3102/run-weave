import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  EMPTY_TERMINAL_SESSIONS,
  useTerminalSessionsQuery,
} from "./queries/terminal-workspace-queries";
import {
  selectTerminalAggregateStatusMaps,
  useTerminalWorkspaceStore,
} from "./workspace-store";

export function useTerminalAggregateStatus() {
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const aggregateState = useTerminalWorkspaceStore(
    useShallow((state) => ({
      bellMarkers: state.bellMarkers,
      completionMarkers: state.completionMarkers,
      terminalStateBySessionId: state.terminalStateBySessionId,
    })),
  );

  return useMemo(
    () => selectTerminalAggregateStatusMaps(aggregateState, sessions),
    [aggregateState, sessions],
  );
}
