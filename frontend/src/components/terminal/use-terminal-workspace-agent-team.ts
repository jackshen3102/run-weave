import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { getAgentTeamRunForTerminal } from "../../services/terminal";
import { canOpenAgentTeamForSession } from "./terminal-session-tab";

interface UseTerminalWorkspaceAgentTeamParams {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  panelSplitEnabled: boolean;
  onSelectSession: (terminalSessionId: string) => void;
  setPanelSplitEnabled: (
    terminalSessionId: string,
    enabled: boolean,
  ) => Promise<TerminalSessionListItem | null>;
}

export function useTerminalWorkspaceAgentTeam({
  apiBase,
  token,
  activeProject,
  activeSession,
  panelSplitEnabled,
  onSelectSession,
  setPanelSplitEnabled,
}: UseTerminalWorkspaceAgentTeamParams) {
  const [activeAgentTeamRunSessionId, setActiveAgentTeamRunSessionId] =
    useState<string | null>(null);
  const [pendingAgentTeamSessionId, setPendingAgentTeamSessionId] = useState<
    string | null
  >(null);
  const autoOpenedAgentTeamSessionIdRef = useRef<string | null>(null);
  const activeAgentTeamRunPresent = Boolean(
    activeSession &&
      activeAgentTeamRunSessionId === activeSession.terminalSessionId,
  );
  const activeAgentTeamAvailable = canOpenAgentTeamForSession(activeSession);
  const showAgentTeamTool = Boolean(
    activeProject &&
      activeSession &&
      (activeAgentTeamRunPresent ||
        pendingAgentTeamSessionId === activeSession.terminalSessionId ||
        activeAgentTeamAvailable),
  );

  const requestAgentTeam = useMemoizedFn(
    (terminalSessionId: string): void => {
      onSelectSession(terminalSessionId);
      setPendingAgentTeamSessionId(terminalSessionId);
      void setPanelSplitEnabled(terminalSessionId, true).then(
        (updatedSession) => {
          if (!updatedSession) {
            setPendingAgentTeamSessionId((current) =>
              current === terminalSessionId ? null : current,
            );
            return;
          }
          useTerminalPreviewStore.getState().openAgentTeam();
        },
      );
    },
  );

  const syncActiveAgentTeamRunForActiveSession = useMemoizedFn(
    (active: boolean): void => {
      const terminalSessionId = activeSession?.terminalSessionId ?? null;
      setActiveAgentTeamRunSessionId(active ? terminalSessionId : null);
    },
  );

  useEffect(() => {
    const terminalSessionId = activeSession?.terminalSessionId ?? null;
    if (!terminalSessionId) {
      autoOpenedAgentTeamSessionIdRef.current = null;
      return;
    }
    if (!activeAgentTeamRunPresent || !showAgentTeamTool) {
      if (autoOpenedAgentTeamSessionIdRef.current === terminalSessionId) {
        autoOpenedAgentTeamSessionIdRef.current = null;
      }
      return;
    }
    if (autoOpenedAgentTeamSessionIdRef.current === terminalSessionId) {
      return;
    }
    autoOpenedAgentTeamSessionIdRef.current = terminalSessionId;
    useTerminalPreviewStore.getState().openAgentTeam();
  }, [
    activeAgentTeamRunPresent,
    activeSession?.terminalSessionId,
    showAgentTeamTool,
  ]);

  useEffect(() => {
    if (!pendingAgentTeamSessionId) {
      return;
    }
    if (
      activeSession?.terminalSessionId === pendingAgentTeamSessionId &&
      (panelSplitEnabled || activeAgentTeamRunPresent)
    ) {
      setPendingAgentTeamSessionId(null);
    }
  }, [
    activeAgentTeamRunPresent,
    activeSession?.terminalSessionId,
    panelSplitEnabled,
    pendingAgentTeamSessionId,
  ]);

  useEffect(() => {
    if (!activeProject?.projectId || !activeSession?.terminalSessionId) {
      setActiveAgentTeamRunSessionId(null);
      return;
    }
    let cancelled = false;
    const terminalSessionId = activeSession.terminalSessionId;
    setActiveAgentTeamRunSessionId(null);
    void getAgentTeamRunForTerminal(
      apiBase,
      token,
      activeProject.projectId,
      terminalSessionId,
    )
      .then((run) => {
        if (cancelled) {
          return;
        }
        setActiveAgentTeamRunSessionId(
          run && run.status !== "done" && run.status !== "failed"
            ? terminalSessionId
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setActiveAgentTeamRunSessionId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProject?.projectId,
    activeSession?.terminalSessionId,
    apiBase,
    token,
  ]);

  return {
    requestAgentTeam,
    showAgentTeamTool,
    syncActiveAgentTeamRunForActiveSession,
  };
}
