import type { ActivityFactsPage } from "./activity/contracts";
import type { AgentTeamRun, AgentTeamStatus } from "./agent-team";
import type {
  AppServerThreadDetailResponse,
  AppServerThreadRef,
} from "./app-server-events";
import type { TerminalSessionListItem } from "./terminal/session";

export type WorkHistorySourceStatus =
  | { status: "available" }
  | { status: "partial"; reason: string }
  | { status: "unavailable"; reason: string };

export interface TerminalThreadMetadata {
  threadId: string;
  provider: string;
  status?: string;
  updatedAt?: string;
}

export interface TerminalArchiveSummary {
  terminalSessionId: string;
  projectId: string;
  title: string;
  cwd?: string;
  command?: string;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  lastThread?: TerminalThreadMetadata;
  knownThreadCount: number;
}

export interface TerminalArchivePage {
  terminals: TerminalArchiveSummary[];
  nextCursor?: string;
  sourceStatus: {
    terminal: WorkHistorySourceStatus;
    appServer: WorkHistorySourceStatus;
  };
}

export interface TerminalArchiveDetail {
  terminal: TerminalSessionListItem;
  threadRefs: AppServerThreadRef[];
  threadDetails: AppServerThreadDetailResponse[];
  nextThreadCursor?: string;
  facts: ActivityFactsPage;
  asOfActivityOffset: number;
  sourceStatus: {
    terminal: WorkHistorySourceStatus;
    activity: WorkHistorySourceStatus;
    appServer: WorkHistorySourceStatus;
    scrollback: WorkHistorySourceStatus;
  };
}

export type AgentTeamArchiveMode = "automatic" | "manual";

export interface AgentTeamArchiveSummary {
  runId: string;
  projectId: string;
  terminalSessionId: string;
  status: AgentTeamStatus;
  mode: AgentTeamArchiveMode;
  createdAt: string;
  updatedAt: string;
  workerCount: number;
  nextRoundIndex: number;
}

export interface AgentTeamArchivePage {
  runs: AgentTeamArchiveSummary[];
  nextCursor?: string;
  sourceStatus: {
    run: WorkHistorySourceStatus;
  };
}

export interface AgentTeamArchiveDetail {
  run: AgentTeamRun;
  facts: ActivityFactsPage;
  asOfActivityOffset: number;
  sourceStatus: {
    run: WorkHistorySourceStatus;
    activity: WorkHistorySourceStatus;
  };
}

export type AgentTeamRoundAttributionSource =
  | "activity_payload"
  | "dispatch_snapshot"
  | "run_log_single_round"
  | "unavailable";

export interface AgentTeamRoundAttribution {
  round: number | null;
  source: AgentTeamRoundAttributionSource;
}

export function resolveAgentTeamRoundAttribution(input: {
  activityRound?: unknown;
  dispatchRound?: unknown;
  runLogRounds?: Iterable<number>;
}): AgentTeamRoundAttribution {
  const activityRound = readPositiveInteger(input.activityRound);
  if (activityRound !== null) {
    return { round: activityRound, source: "activity_payload" };
  }
  const dispatchRound = readPositiveInteger(input.dispatchRound);
  if (dispatchRound !== null) {
    return { round: dispatchRound, source: "dispatch_snapshot" };
  }
  const runLogRounds = new Set(
    [...(input.runLogRounds ?? [])].filter(
      (value) => Number.isInteger(value) && value > 0,
    ),
  );
  if (runLogRounds.size === 1) {
    return {
      round: runLogRounds.values().next().value ?? null,
      source: "run_log_single_round",
    };
  }
  return { round: null, source: "unavailable" };
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
