import type {
  EvolutionClaim,
  EvolutionClaimNovelty,
  Insight,
} from "@runweave/shared/evolution";

export function classifyClaimNovelty(
  claims: EvolutionClaim[],
  baseline: Insight[],
): EvolutionClaimNovelty[] {
  const baselineByTopic = new Map(
    baseline.map((insight) => [insight.topicKey, insight]),
  );
  return claims.map((claim) => {
    const insight = baselineByTopic.get(claim.topicKey);
    const current = insight?.revisions.find(
      (revision) => revision.revisionId === insight.currentRevisionId,
    );
    if (!current) {
      return {
        claimId: claim.claimId,
        novelty: "novel",
        baselineRevisionId: null,
        rationale: "no_matching_topic_in_knowledge_baseline",
      };
    }
    if (normalize(current.statement) !== normalize(claim.statement)) {
      return {
        claimId: claim.claimId,
        novelty: claim.topicKey.startsWith("drift.")
          ? "drift"
          : "contradiction",
        baselineRevisionId: current.revisionId,
        rationale: "statement_differs_from_current_insight_revision",
      };
    }
    const currentEvidence = new Set(current.evidenceIds);
    const addedEvidence = claim.supportingEvidenceIds.some(
      (evidenceId) => !currentEvidence.has(evidenceId),
    );
    return {
      claimId: claim.claimId,
      novelty: addedEvidence ? "reinforced" : "known",
      baselineRevisionId: current.revisionId,
      rationale: addedEvidence
        ? "matching_statement_has_new_supporting_evidence"
        : "statement_and_evidence_already_known",
    };
  });
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
