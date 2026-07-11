import { useDebounceFn, useMemoizedFn } from "ahooks";
import { useEffect, useRef } from "react";
import type { TerminalEventEnvelope } from "@runweave/shared";
import { createTerminalBellPlayer } from "../../features/terminal/bell";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import { useTerminalEventsConnection } from "../../features/terminal/use-terminal-events-connection";

const BELL_MARKER_DURATION_MS = 2_000;
const TERMINAL_LIST_REFRESH_DEBOUNCE_MS = 50;

interface UseTerminalWorkspaceEventsArgs {
  apiBase: string;
  token: string;
  onAuthExpired?: () => void;
  loadSessions: () => Promise<void>;
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
  onAuthExpired,
  loadSessions,
  selectActiveSession,
}: UseTerminalWorkspaceEventsArgs) {
  const setTerminalStateBySessionId = useTerminalWorkspaceStore(
    (state) => state.setTerminalStateBySessionId,
  );
  const setPanelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.setPanelWorkspaceBySessionId,
  );
  const setActivePanelIdBySessionId = useTerminalWorkspaceStore(
    (state) => state.setActivePanelIdBySessionId,
  );
  const setCompletionMarkers = useTerminalWorkspaceStore(
    (state) => state.setCompletionMarkers,
  );
  const setActiveProjectId = useTerminalWorkspaceStore(
    (state) => state.setActiveProjectId,
  );
  const setSessions = useTerminalWorkspaceStore((state) => state.setSessions);
  const setBellMarkers = useTerminalWorkspaceStore(
    (state) => state.setBellMarkers,
  );
  const terminalEventCursorRef = useRef<string | null>(null);
  const pendingCreatedSessionRef = useRef<Extract<
    TerminalEventEnvelope,
    { kind: "terminal_session_created" }
  > | null>(null);
  const completionBellPlayerRef = useRef<ReturnType<
    typeof createTerminalBellPlayer
  > | null>(null);

  const resetTerminalEventCursor = useMemoizedFn(() => {
    terminalEventCursorRef.current = null;
  });

  const {
    run: scheduleTerminalListRefresh,
    cancel: cancelTerminalListRefresh,
  } = useDebounceFn(
    () => {
      const latestCreatedSession = pendingCreatedSessionRef.current;
      pendingCreatedSessionRef.current = null;
      void loadSessions().then(() => {
        if (
          !latestCreatedSession ||
          useTerminalWorkspaceStore.getState().activeSessionId
        ) {
          return;
        }
        setActiveProjectId(latestCreatedSession.projectId);
        selectActiveSession(latestCreatedSession.terminalSessionId);
      });
    },
    { wait: TERMINAL_LIST_REFRESH_DEBOUNCE_MS },
  );

  useEffect(
    () => () => {
      cancelTerminalListRefresh();
    },
    [cancelTerminalListRefresh],
  );

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

      const panelEvents = events.filter(
        (event) =>
          event.kind === "terminal_panel_created" ||
          event.kind === "terminal_panel_updated" ||
          event.kind === "terminal_panel_deleted" ||
          event.kind === "terminal_panel_focused" ||
          event.kind === "terminal_panel_input_sent",
      );
      if (panelEvents.length > 0) {
        setPanelWorkspaceBySessionId((current) => {
          let changed = false;
          const next = { ...current };
          for (const event of panelEvents) {
            const workspace = event.payload.workspace;
            if (
              next[event.terminalSessionId]?.activePanelId ===
                workspace.activePanelId &&
              (next[event.terminalSessionId]?.panels?.length ?? 0) ===
                (workspace.panels?.length ?? 0)
            ) {
              continue;
            }
            next[event.terminalSessionId] = workspace;
            changed = true;
          }
          return changed ? next : current;
        });
        setActivePanelIdBySessionId((current) => {
          let changed = false;
          const next = { ...current };
          for (const event of panelEvents) {
            const activePanelId = event.payload.workspace.activePanelId;
            if (next[event.terminalSessionId] === activePanelId) {
              continue;
            }
            next[event.terminalSessionId] = activePanelId;
            changed = true;
          }
          return changed ? next : current;
        });
      }

      const metadataBySessionId = new Map<
        string,
        { cwd: string; activeCommand: string | null }
      >();
      for (const event of events) {
        if (event.kind === "terminal_session_metadata_changed") {
          metadataBySessionId.set(event.terminalSessionId, event.payload.next);
        }
      }
      if (metadataBySessionId.size > 0) {
        setSessions((currentSessions) => {
          let changed = false;
          const nextSessions = currentSessions.map((session) => {
            const metadata = metadataBySessionId.get(session.terminalSessionId);
            if (
              !metadata ||
              (session.cwd === metadata.cwd &&
                session.activeCommand === metadata.activeCommand)
            ) {
              return session;
            }
            changed = true;
            return {
              ...session,
              cwd: metadata.cwd,
              activeCommand: metadata.activeCommand,
            };
          });
          return changed ? nextSessions : currentSessions;
        });
      }

      if (events.some(isTerminalListInvalidationEvent)) {
        const latestCreatedSession = getLatestCreatedSessionEvent(events);
        if (latestCreatedSession) {
          pendingCreatedSessionRef.current = latestCreatedSession;
        }
        scheduleTerminalListRefresh();
      }

      const knownSessionIds = new Set(
        useTerminalWorkspaceStore
          .getState()
          .sessions.map((session) => session.terminalSessionId),
      );
      if (delivery === "live") {
        const activeSessionId =
          useTerminalWorkspaceStore.getState().activeSessionId;
        const bellSessionIds = new Set(
          events
            .filter((event) => event.kind === "terminal_bell")
            .map((event) => event.terminalSessionId)
            .filter(
              (terminalSessionId) =>
                terminalSessionId !== activeSessionId &&
                knownSessionIds.has(terminalSessionId),
            ),
        );
        if (bellSessionIds.size > 0) {
          setBellMarkers((current) => {
            let changed = false;
            const next = { ...current };
            for (const terminalSessionId of bellSessionIds) {
              if (!next[terminalSessionId]) {
                next[terminalSessionId] = true;
                changed = true;
              }
            }
            return changed ? next : current;
          });
          for (const terminalSessionId of bellSessionIds) {
            window.setTimeout(() => {
              setBellMarkers((current) => {
                if (!current[terminalSessionId]) {
                  return current;
                }
                const next = { ...current };
                delete next[terminalSessionId];
                return next;
              });
            }, BELL_MARKER_DURATION_MS);
          }
        }
      }
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
  const setCompletionEventCursor = useMemoizedFn((cursor: string | null) => {
    terminalEventCursorRef.current = cursor;
  });

  const resyncTerminalWorkspace = useMemoizedFn(() => {
    void loadSessions();
  });

  useTerminalEventsConnection({
    apiBase,
    token,
    getCursor: getCompletionEventCursor,
    setCursor: setCompletionEventCursor,
    onAuthExpired,
    onResyncRequired: resyncTerminalWorkspace,
    onTerminalEvents: applyTerminalEvents,
  });

  return { resetTerminalEventCursor };
}
