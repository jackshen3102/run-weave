import { createHash } from "node:crypto";
import type {
  EvolutionAnalysisReport,
  EvolutionClaim,
} from "@runweave/shared/evolution";
import type { CrossQuestionOutput } from "./output-schemas";

export function buildClaimLedger(params: {
  runId: string;
  learningScopeId: string;
  reports: EvolutionAnalysisReport[];
  crossQuestion: CrossQuestionOutput | null;
  createdAt: string;
}): EvolutionClaim[] {
  const crossByTopic = new Map(
    (params.crossQuestion?.reviews ?? []).map((review) => [
      review.topicKey,
      review,
    ]),
  );
  const claimsByTopicAndStatement = new Map<
    string,
    Array<{
      report: EvolutionAnalysisReport;
      claim: EvolutionAnalysisReport["claims"][number];
    }>
  >();
  for (const report of params.reports) {
    for (const claim of report.claims) {
      const key = `${claim.topicKey}\0${normalize(claim.statement)}`;
      claimsByTopicAndStatement.set(key, [
        ...(claimsByTopicAndStatement.get(key) ?? []),
        { report, claim },
      ]);
    }
  }
  const statementCountsByTopic = new Map<string, number>();
  for (const entries of claimsByTopicAndStatement.values()) {
    const first = entries[0];
    if (!first) continue;
    const topicKey = first.claim.topicKey;
    statementCountsByTopic.set(
      topicKey,
      (statementCountsByTopic.get(topicKey) ?? 0) + 1,
    );
  }

  return Array.from(claimsByTopicAndStatement.values())
    .flatMap((entries): EvolutionClaim[] => {
      const firstEntry = entries[0];
      if (!firstEntry) return [];
      const first = firstEntry.claim;
      const cross = crossByTopic.get(first.topicKey);
      const competingStatements =
        (statementCountsByTopic.get(first.topicKey) ?? 0) > 1;
      const status = competingStatements
        ? "contested"
        : (cross?.status ??
          (entries.length > 1 ? "corroborated" : "insufficient_evidence"));
      const supportingEvidenceIds = unique(
        entries.flatMap(({ claim }) => claim.supportingEvidenceIds),
      );
      const counterEvidenceIds = unique([
        ...entries.flatMap(({ claim }) => claim.counterEvidenceIds),
        ...(cross?.counterEvidenceIds ?? []),
      ]);
      return [{
        claimId: stableId("claim", [
          params.runId,
          first.topicKey,
          normalize(first.statement),
        ]),
        runId: params.runId,
        learningScopeId: params.learningScopeId,
        topicKey: first.topicKey,
        statement: first.statement,
        scope: first.scope,
        status,
        supportingEvidenceIds,
        counterEvidenceIds,
        reportIds: entries.map(({ report }) => report.reportId).sort(),
        missingEvidence: [...(cross?.missingEvidence ?? [])],
        candidateType: first.candidateType,
        guidance: first.guidance,
        risk: first.risk,
        createdAt: params.createdAt,
      }];
    })
    .sort(
      (left, right) =>
        left.topicKey.localeCompare(right.topicKey) ||
        left.claimId.localeCompare(right.claimId),
    );
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}
