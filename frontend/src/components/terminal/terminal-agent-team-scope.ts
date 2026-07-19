import { useMemoizedFn } from "ahooks";
import { useRef } from "react";
import type { AgentTeamRun } from "@runweave/shared/agent-team";

export function useAgentTeamScopeGuard(
  projectId: string | null,
  terminalSessionId: string | null,
  onRunMismatch: () => void,
) {
  const activeScopeRef = useRef({ projectId, terminalSessionId });
  activeScopeRef.current = { projectId, terminalSessionId };

  const isCurrentScope = useMemoizedFn(
    (expectedProjectId: string, expectedTerminalSessionId: string): boolean =>
      activeScopeRef.current.projectId === expectedProjectId &&
      activeScopeRef.current.terminalSessionId === expectedTerminalSessionId,
  );
  const canApplyRunToCurrentScope = useMemoizedFn(
    (
      next: AgentTeamRun | null,
      expectedProjectId: string,
      expectedTerminalSessionId: string,
    ): boolean => {
      if (!isCurrentScope(expectedProjectId, expectedTerminalSessionId)) {
        return false;
      }
      if (
        next &&
        (next.projectId !== expectedProjectId ||
          next.terminalSessionId !== expectedTerminalSessionId)
      ) {
        onRunMismatch();
        return false;
      }
      return true;
    },
  );

  return { canApplyRunToCurrentScope, isCurrentScope };
}
