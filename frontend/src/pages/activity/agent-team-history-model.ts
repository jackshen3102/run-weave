import type { ActivityFactDto } from "@runweave/shared/activity";
import type { AgentTeamArchiveDetail } from "@runweave/shared/work-history";
import { resolveAgentTeamRoundAttribution } from "@runweave/shared/work-history";
import type { WorkHistorySelection } from "./work-history-selection";

export interface AgentTeamJournalItem {
  id: string;
  occurredAt: string;
  title: string;
  summary: string;
  round: number | null;
  attributionSource:
    | "activity_payload"
    | "dispatch_snapshot"
    | "run_log_single_round"
    | "unavailable";
  selection: WorkHistorySelection;
}

export interface AgentTeamJournal {
  setup: AgentTeamJournalItem[];
  rounds: Array<{ round: number; items: AgentTeamJournalItem[] }>;
  acceptance: AgentTeamJournalItem[];
  unassigned: AgentTeamJournalItem[];
}

export function buildAgentTeamJournal(
  detail: AgentTeamArchiveDetail,
): AgentTeamJournal {
  const logRounds = readLogRounds(detail.run.logs);
  const setup: AgentTeamJournalItem[] = [
    {
      id: `run:${detail.run.runId}`,
      occurredAt: detail.run.createdAt,
      title: "Run created",
      summary: detail.run.task,
      round: null,
      attributionSource: "unavailable",
      selection: { type: "run", run: detail.run },
    },
    ...detail.run.workers.map((worker) => ({
      id: `worker:${worker.id}`,
      occurredAt: detail.run.createdAt,
      title: `${worker.role} worker`,
      summary: worker.intent,
      round: null,
      attributionSource: "unavailable" as const,
      selection: { type: "worker" as const, worker },
    })),
  ];
  const roundItems = new Map<number, AgentTeamJournalItem[]>();
  const unassigned: AgentTeamJournalItem[] = [];
  for (const fact of detail.facts.facts.filter(isRoundFact)) {
    const attribution = resolveAgentTeamRoundAttribution({
      activityRound: fact.payload.round,
      dispatchRound: readDispatchRound(detail, fact),
      runLogRounds: logRounds,
    });
    const item: AgentTeamJournalItem = {
      id: `fact:${fact.eventId}`,
      occurredAt: fact.occurredAt,
      title: fact.eventName,
      summary: fact.result?.status ?? readPayloadSummary(fact),
      round: attribution.round,
      attributionSource: attribution.source,
      selection: {
        type: "fact",
        fact,
        round: attribution.round,
        attributionSource: attribution.source,
      },
    };
    if (attribution.round === null) {
      unassigned.push(item);
    } else {
      const items = roundItems.get(attribution.round) ?? [];
      items.push(item);
      roundItems.set(attribution.round, items);
    }
  }
  const acceptance = detail.run.acceptance.flatMap<AgentTeamJournalItem>((item) => [
    {
      id: `case:${item.caseId}`,
      occurredAt: detail.run.updatedAt,
      title: item.caseId,
      summary: item.resultSummary ?? (item.status === "pending" ? "未记录" : item.status),
      round: null,
      attributionSource: "unavailable",
      selection: { type: "case", acceptanceCase: item },
    },
    ...item.evidence.map((evidence, index) => ({
      id: `evidence:${item.caseId}:${index}`,
      occurredAt: detail.run.updatedAt,
      title: evidence.label,
      summary: evidence.summary,
      round: null,
      attributionSource: "unavailable" as const,
      selection: { type: "evidence" as const, evidence, caseId: item.caseId },
    })),
  ]);
  return {
    setup: setup.sort(compareItems),
    rounds: [...roundItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([round, items]) => ({ round, items: items.sort(compareItems) })),
    acceptance: acceptance.sort(compareItems),
    unassigned: unassigned.sort(compareItems),
  };
}

function isRoundFact(fact: ActivityFactDto): boolean {
  return fact.eventName.startsWith("agent_team.worker.") ||
    fact.eventName.startsWith("agent_team.case.");
}

function readDispatchRound(
  detail: AgentTeamArchiveDetail,
  fact: ActivityFactDto,
): number | undefined {
  const dispatch = detail.run.activeWorkerDispatch;
  if (!dispatch?.round || dispatch.requestedAt !== fact.occurredAt) {
    return undefined;
  }
  return dispatch.round;
}

function readLogRounds(logs: string[]): number[] {
  return logs.flatMap((line) => {
    const matches = [...line.matchAll(/\bround\s+(\d+)\b/gi)];
    return matches
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value) && value > 0);
  });
}

function readPayloadSummary(fact: ActivityFactDto): string {
  for (const key of ["summary", "reportedStatus", "role", "caseId"]) {
    const value = fact.payload[key];
    if (typeof value === "string" && value) return value;
  }
  return fact.runtime.surface;
}

function compareItems(
  left: AgentTeamJournalItem,
  right: AgentTeamJournalItem,
): number {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    left.id.localeCompare(right.id);
}
