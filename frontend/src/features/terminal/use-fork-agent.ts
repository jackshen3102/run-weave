import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import { forkTerminalAgent, getTerminalAgentForkTarget } from "../../services/terminal/sessions";
import { HttpError } from "../../services/http";
import { useTerminalRuntime } from "./queries/provider";
import { useTerminalSessionsQuery } from "./queries/workspace";
import { useTerminalWorkspaceStore } from "./state/workspace-store";

export function useForkTerminalAgent(terminalId: string) {
  const { apiBase, token, scope, onAuthExpired } = useTerminalRuntime();
  const sessions = useTerminalSessionsQuery();
  const currentScope = useRef<string | null>(scope);
  currentScope.current = scope;
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = null;
      if (inFlight.current) useTerminalWorkspaceStore.getState().setLoading(false);
    };
  }, [scope]);
  const fork = useMemoizedFn(async () => {
    if (inFlight.current || useTerminalWorkspaceStore.getState().loading) return;
    inFlight.current = true;
    setPending(true);
    const requestedScope = scope;
    const workspace = useTerminalWorkspaceStore.getState();
    workspace.setLoading(true);
    workspace.setRequestError(null);
    let createdId: string | undefined;
    let failure: string | null = null;
    try {
      const target = await getTerminalAgentForkTarget(apiBase, token, terminalId);
      if (currentScope.current !== requestedScope) return;
      const result = await forkTerminalAgent(apiBase, token, terminalId, {
        operationId: crypto.randomUUID(), panelId: target.panelId,
        expectedThreadId: target.threadId, expectedRevision: target.revision,
      });
      createdId = result.terminalSessionId;
    } catch (error) {
      if (currentScope.current !== requestedScope) return;
      if (error instanceof HttpError && error.status === 401) { onAuthExpired?.(); return; }
      if (error instanceof HttpError && error.details && typeof error.details === "object" &&
        "terminalSessionId" in error.details && typeof error.details.terminalSessionId === "string") {
        createdId = error.details.terminalSessionId;
      }
      failure = error instanceof Error ? error.message : String(error);
      if (!(error instanceof HttpError)) failure = "Fork 结果未确认，请核对终端列表；不会自动重试。";
    } finally {
      if (currentScope.current === requestedScope) {
        if (createdId) {
          await sessions.refetch();
          const current = useTerminalWorkspaceStore.getState();
          if (currentScope.current === requestedScope && current.activeProjectId === workspace.activeProjectId &&
            current.activeSessionId === workspace.activeSessionId) workspace.setActiveSessionId(createdId);
        }
        if (currentScope.current === requestedScope) {
          workspace.setRequestError(failure);
          workspace.setLoading(false);
        }
      }
      inFlight.current = false;
      if (currentScope.current !== null) setPending(false);
    }
  });
  return { fork, pending };
}
