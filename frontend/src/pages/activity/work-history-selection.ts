import type { ActivityFactDto } from "@runweave/shared/activity";
import type {
  AgentTeamAcceptanceCase,
  AgentTeamAcceptanceEvidence,
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import type { AppServerThreadDetailResponse } from "@runweave/shared/app-server-events";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";

export type WorkHistorySelection =
  | { type: "terminal"; terminal: TerminalSessionListItem }
  | { type: "thread"; thread: AppServerThreadDetailResponse }
  | {
      type: "fact";
      fact: ActivityFactDto;
      round?: number | null;
      attributionSource?:
        | "activity_payload"
        | "dispatch_snapshot"
        | "run_log_single_round"
        | "unavailable";
    }
  | { type: "run"; run: AgentTeamRun }
  | { type: "worker"; worker: AgentTeamWorker }
  | { type: "case"; acceptanceCase: AgentTeamAcceptanceCase }
  | {
      type: "evidence";
      evidence: AgentTeamAcceptanceEvidence;
      caseId: string;
    };

export function selectionKey(selection: WorkHistorySelection): string {
  switch (selection.type) {
    case "terminal":
      return `terminal:${selection.terminal.terminalSessionId}`;
    case "thread":
      return `thread:${selection.thread.thread.threadId}`;
    case "fact":
      return `fact:${selection.fact.eventId}`;
    case "run":
      return `run:${selection.run.runId}`;
    case "worker":
      return `worker:${selection.worker.id}`;
    case "case":
      return `case:${selection.acceptanceCase.caseId}`;
    case "evidence":
      return `evidence:${selection.caseId}:${selection.evidence.label}`;
  }
}
