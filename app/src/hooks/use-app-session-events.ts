import { useDebounceFn, useMemoizedFn } from "ahooks";
import { useQueryClient } from "@tanstack/react-query";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type {
  AppHomeOverviewResponse,
  AppHomeOverviewSession,
} from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { useEffect } from "react";
import { appQueryKeys } from "../features/query/app-query-provider";
import { useAppTerminalEventsConnection } from "./use-app-terminal-events-connection";

const OVERVIEW_REFRESH_DEBOUNCE_MS = 50;

function resolveSessionDisplayStatus(
  session: AppHomeOverviewSession,
  terminalState: TerminalState,
): Pick<AppHomeOverviewSession, "displayStatus" | "displayStatusLabel"> {
  if (session.status === "exited") {
    return { displayStatus: "exited", displayStatusLabel: "Exited" };
  }
  if (terminalState.state === "agent_running") {
    return { displayStatus: "running", displayStatusLabel: "Agent Running" };
  }
  if (terminalState.state === "agent_starting") {
    return {
      displayStatus: "agent-starting",
      displayStatusLabel: "Agent Starting",
    };
  }
  if (terminalState.state === "agent_idle") {
    return { displayStatus: "agent-idle", displayStatusLabel: "Agent Idle" };
  }
  return { displayStatus: "idle", displayStatusLabel: "Idle" };
}

function isOverviewInvalidationEvent(event: TerminalEventEnvelope): boolean {
  return (
    event.kind === "project_created" ||
    event.kind === "project_deleted" ||
    event.kind === "terminal_session_created" ||
    event.kind === "terminal_session_deleted"
  );
}

export function useAppSessionEvents(input: {
  apiBase: string;
  accessToken: string;
  enabled: boolean;
  queryScope: string;
  onAuthExpired: () => void;
  onConnectionFailure: () => Promise<boolean>;
  onOverviewInvalidated: () => Promise<void>;
  onServerConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const { run: scheduleOverviewRefresh, cancel: cancelOverviewRefresh } =
    useDebounceFn(() => void input.onOverviewInvalidated(), {
      wait: OVERVIEW_REFRESH_DEBOUNCE_MS,
    });

  useEffect(
    () => () => {
      cancelOverviewRefresh();
    },
    [cancelOverviewRefresh],
  );

  const handleTerminalEvents = useMemoizedFn(
    (events: TerminalEventEnvelope[]) => {
      if (events.some(isOverviewInvalidationEvent)) {
        scheduleOverviewRefresh();
      }
      const stateEvents = events.filter(
        (event) => event.kind === "terminal_state_changed",
      );
      const metadataEvents = events.filter(
        (event) => event.kind === "terminal_session_metadata_changed",
      );
      if (stateEvents.length === 0 && metadataEvents.length === 0) {
        return;
      }

      queryClient.setQueryData<AppHomeOverviewResponse | null>(
        appQueryKeys.overview(input.queryScope),
        (currentOverview) => {
          if (!currentOverview) {
            return currentOverview;
          }
          let changed = false;
          const nextStateBySessionId = new Map(
            stateEvents.map((event) => [
              event.terminalSessionId,
              event.payload.next,
            ]),
          );
          const nextMetadataBySessionId = new Map(
            metadataEvents.map((event) => [
              event.terminalSessionId,
              event.payload,
            ]),
          );
          const sessions = currentOverview.sessions.map((session) => {
            const terminalState = nextStateBySessionId.get(
              session.terminalSessionId,
            );
            const metadata = nextMetadataBySessionId.get(
              session.terminalSessionId,
            );
            if (!terminalState && !metadata) {
              return session;
            }
            const displayStatus = terminalState
              ? resolveSessionDisplayStatus(session, terminalState)
              : null;
            if (
              (!terminalState ||
                (session.terminalState.state === terminalState.state &&
                  session.terminalState.agent === terminalState.agent &&
                  session.displayStatus === displayStatus?.displayStatus &&
                  session.displayStatusLabel ===
                    displayStatus?.displayStatusLabel)) &&
              (!metadata ||
                (session.cwd === metadata.next.cwd &&
                  session.activeCommand === metadata.next.activeCommand))
            ) {
              return session;
            }
            changed = true;
            return {
              ...session,
              ...(metadata
                ? {
                    cwd: metadata.next.cwd,
                    activeCommand: metadata.next.activeCommand,
                    subtitle:
                      session.subtitle === metadata.previous.cwd
                        ? metadata.next.cwd
                        : session.subtitle,
                  }
                : {}),
              ...(displayStatus ?? {}),
              ...(terminalState ? { terminalState } : {}),
            };
          });
          return changed ? { ...currentOverview, sessions } : currentOverview;
        },
      );
    },
  );

  const handleResyncRequired = useMemoizedFn(() => {
    void input.onOverviewInvalidated();
  });

  useAppTerminalEventsConnection({
    apiBase: input.apiBase,
    accessToken: input.accessToken,
    enabled: input.enabled,
    onAuthExpired: input.onAuthExpired,
    onConnectionClose: input.onConnectionFailure,
    onConnectionError: input.onConnectionFailure,
    onResyncRequired: handleResyncRequired,
    onServerConnected: input.onServerConnected,
    onTerminalEvents: handleTerminalEvents,
  });
}
