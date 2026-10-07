import { useMemoizedFn } from "ahooks";
import { useEffect, useRef } from "react";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { isAttentionTerminalOpening } from "../../../features/attention/use-attention-open-intents";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { updateTerminalSessions, useTerminalWorkspaceQueryClient } from "../../../features/terminal/queries/workspace";
import { HttpError } from "../../../services/http";
import { updateTerminalSession } from "../../../services/terminal/index";

export function useTerminalCompletionRead({
  apiBase, token, scope, initialTerminalSessionId, activeSession, ready, onAuthExpired,
}: {
  apiBase: string;
  token: string;
  scope: string;
  initialTerminalSessionId?: string;
  activeSession: TerminalSessionListItem | null;
  ready: boolean;
  onAuthExpired?: () => void;
}) {
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const opened = useRef(false);
  const tabSelection = useRef<string | null>(null);
  const acknowledge = useMemoizedFn((terminalSessionId: string, completionRevision: number) => {
    if (terminalSessionId !== initialTerminalSessionId) tabSelection.current = terminalSessionId;
    if (!completionRevision) return;
    const { setCompletionMarkers } = useTerminalWorkspaceStore.getState();
    setCompletionMarkers((current) => {
      if (current[terminalSessionId] !== completionRevision) return current;
      const next = { ...current };
      delete next[terminalSessionId];
      return next;
    });
    void updateTerminalSession(apiBase, token, terminalSessionId, {
      acknowledgedCompletionRevision: completionRevision,
    }).then((updatedSession) => {
      updateTerminalSessions(queryClient, scope, (sessions) => sessions.map((session) =>
        session.terminalSessionId === terminalSessionId ? {
          ...session,
          completionRevision: Math.max(session.completionRevision, updatedSession.completionRevision),
          acknowledgedCompletionRevision: Math.max(
            session.acknowledgedCompletionRevision, updatedSession.acknowledgedCompletionRevision,
          ),
        } : session,
      ));
    }).catch((error: unknown) => {
      setCompletionMarkers((current) => ({
        ...current,
        [terminalSessionId]: Math.max(current[terminalSessionId] ?? 0, completionRevision),
      }));
      if (error instanceof HttpError && error.status === 401) onAuthExpired?.();
    });
  });
  useEffect(() => {
    opened.current = false;
  }, [scope, initialTerminalSessionId]);
  useEffect(() => {
    if (opened.current || !ready || !initialTerminalSessionId ||
      activeSession?.terminalSessionId !== initialTerminalSessionId ||
      useTerminalWorkspaceStore.getState().activeSessionId !== initialTerminalSessionId) return;
    // Read once on entering this route. Later completions on the same page stay unread.
    opened.current = true;
    if (tabSelection.current === initialTerminalSessionId) {
      tabSelection.current = null;
      return;
    }
    if (isAttentionTerminalOpening(apiBase, initialTerminalSessionId)) return;
    if (activeSession.completionRevision > activeSession.acknowledgedCompletionRevision) {
      acknowledge(initialTerminalSessionId, activeSession.completionRevision);
    }
  }, [acknowledge, activeSession, apiBase, initialTerminalSessionId, ready, scope]);
  return acknowledge;
}
