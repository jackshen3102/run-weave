import type { ActivityFactsPage } from "./activity/contracts";
import type {
  AppServerThreadDetailResponse,
  AppServerThreadRef,
} from "./app-server/events";
import type { TerminalSessionListItem } from "./terminal/runtime/session";

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
