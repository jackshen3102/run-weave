import { useMemoizedFn } from "ahooks";
import { useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  TerminalEventEnvelope,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import { createTerminalBellPlayer } from "../../features/terminal/bell";
import { useTerminalEventsConnection } from "../../features/terminal/use-terminal-events-connection";

interface UseTerminalWorkspaceEventsArgs {
  apiBase: string;
  token: string;
  sessionsRef: RefObject<TerminalSessionListItem[]>;
  activeSessionIdRef: RefObject<string | null>;
  onAuthExpired?: () => void;
  setTerminalStateBySessionId: Dispatch<
    SetStateAction<Record<string, TerminalState>>
  >;
  setCompletionMarkers: Dispatch<SetStateAction<Record<string, boolean>>>;
  loadSessions: () => Promise<void>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  selectActiveSession: (terminalSessionId: string | null) => void;
}

function isTerminalListInvalidationEvent(
  event: TerminalEventEnvelope,
): boolean {
  return (
    event.kind === "project_created" ||
    event.kind === "project_deleted" ||
    event.kind === "terminal_session_created" ||
    event.kind === "terminal_session_deleted"
  );
}

function getLatestCreatedSessionEvent(
  events: TerminalEventEnvelope[],
): Extract<TerminalEventEnvelope, { kind: "terminal_session_created" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "terminal_session_created") {
      return event;
    }
  }
  return null;
}

export function useTerminalWorkspaceEvents({
  apiBase,
  token,
  sessionsRef,
  activeSessionIdRef,
  onAuthExpired,
  setTerminalStateBySessionId,
  setCompletionMarkers,
  loadSessions,
  setActiveProjectId,
  selectActiveSession,
}: UseTerminalWorkspaceEventsArgs) {
  const terminalEventCursorRef = useRef<string | null>(null);
  const completionBellPlayerRef = useRef<ReturnType<
    typeof createTerminalBellPlayer
  > | null>(null);

  const resetTerminalEventCursor = useMemoizedFn(() => {
    terminalEventCursorRef.current = null;
  });

  const applyTerminalEvents = useMemoizedFn(
    (events: TerminalEventEnvelope[], delivery: "catchup" | "live"): void => {
      const latestEvent = events[events.length - 1];
      if (latestEvent) {
        terminalEventCursorRef.current = latestEvent.id;
      }

      const stateEvents = events.filter(
        (event) => event.kind === "terminal_state_changed",
      );
      if (stateEvents.length > 0) {
        setTerminalStateBySessionId((current) => {
          let changed = false;
          const next = { ...current };
          for (const event of stateEvents) {
            if (event.kind !== "terminal_state_changed") {
              continue;
            }
            const terminalState = event.payload.next;
            const currentState = next[event.terminalSessionId];
            if (
              currentState?.state === terminalState.state &&
              currentState.agent === terminalState.agent
            ) {
              continue;
            }
            next[event.terminalSessionId] = terminalState;
            changed = true;
          }
          return changed ? next : current;
        });
      }

      if (events.some(isTerminalListInvalidationEvent)) {
        const latestCreatedSession = getLatestCreatedSessionEvent(events);
        void loadSessions().then(() => {
          if (!latestCreatedSession || activeSessionIdRef.current) {
            return;
          }
          setActiveProjectId(latestCreatedSession.projectId);
          selectActiveSession(latestCreatedSession.terminalSessionId);
        });
      }

      const knownSessionIds = new Set(
        sessionsRef.current.map((session) => session.terminalSessionId),
      );
      const markerSessionIds = events
        .filter((event) => event.kind === "completion")
        .map((event) => event.terminalSessionId)
        .filter((terminalSessionId) => knownSessionIds.has(terminalSessionId));
      if (markerSessionIds.length === 0) {
        return;
      }

      setCompletionMarkers((current) => {
        let changed = false;
        const next = { ...current };
        for (const terminalSessionId of markerSessionIds) {
          if (!next[terminalSessionId]) {
            next[terminalSessionId] = true;
            changed = true;
          }
        }
        return changed ? next : current;
      });

      if (delivery === "live" && window.electronAPI?.isElectron === true) {
        completionBellPlayerRef.current ??= createTerminalBellPlayer();
        void completionBellPlayerRef.current.play();
      }
    },
  );

  const getCompletionEventCursor = useMemoizedFn(
    () => terminalEventCursorRef.current,
  );
  const setCompletionEventCursor = useMemoizedFn((cursor: string) => {
    terminalEventCursorRef.current = cursor;
  });

  useTerminalEventsConnection({
    apiBase,
    token,
    getCursor: getCompletionEventCursor,
    setCursor: setCompletionEventCursor,
    onAuthExpired,
    onTerminalEvents: applyTerminalEvents,
  });

  return { resetTerminalEventCursor };
}
