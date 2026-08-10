import type {
  ContextPackEvidenceRef,
  EvolutionClaim,
  EvolutionClaimNovelty,
  Insight,
} from "@runweave/shared/evolution";

export function classifyClaimNovelty(
  claims: EvolutionClaim[],
  baseline: Insight[],
  evidence: ContextPackEvidenceRef[] = [],
): EvolutionClaimNovelty[] {
  const baselineByTopic = new Map(
    baseline.map((insight) => [insight.topicKey, insight]),
  );
  const baselineRevisions = baseline.flatMap((insight) =>
    insight.revisions
      .filter((revision) => revision.revisionId === insight.currentRevisionId)
      .map((revision) => ({ topicKey: insight.topicKey, revision })),
  );
  const evidenceById = new Map(
    evidence.map((item) => [item.evidenceId, item]),
  );
  return claims.map((claim) => {
    const evidenceClassification = classifyEvidence(
      claim,
      evidenceById,
    );
    if (evidenceClassification) {
      return {
        claimId: claim.claimId,
        novelty: "known",
        baselineRevisionId: null,
        rationale: evidenceClassification,
      };
    }
    if (!isDuplicateRepresentative(claim, claims)) {
      return {
        claimId: claim.claimId,
        novelty: "known",
        baselineRevisionId: null,
        rationale: "semantically_duplicate_claim_in_same_run",
      };
    }
    const insight = baselineByTopic.get(claim.topicKey);
    const current = insight?.revisions.find(
      (revision) => revision.revisionId === insight.currentRevisionId,
    );
    if (!current) {
      const semanticMatch = bestSemanticMatch(claim, baselineRevisions);
      if (semanticMatch) {
        const currentEvidence = new Set(semanticMatch.evidenceIds);
        const addedEvidence = claim.supportingEvidenceIds.some(
          (evidenceId) => !currentEvidence.has(evidenceId),
        );
        return {
          claimId: claim.claimId,
          novelty: addedEvidence ? "reinforced" : "known",
          baselineRevisionId: semanticMatch.revisionId,
          rationale: addedEvidence
            ? "semantically_matching_insight_has_new_supporting_evidence"
            : "statement_semantically_matches_existing_insight",
        };
      }
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

function classifyEvidence(
  claim: EvolutionClaim,
  evidenceById: Map<string, ContextPackEvidenceRef>,
): string | null {
  const resolved = claim.supportingEvidenceIds.flatMap((evidenceId) => {
    const item = evidenceById.get(evidenceId);
    return item ? [item] : [];
  });
  if (
    resolved.length > 0 &&
    resolved.every((item) => item.source === "repository")
  ) {
    return "repository_baseline_only";
  }
  if (
    resolved.length > 0 &&
    resolved.every((item) => isSyntheticEvidence(item))
  ) {
    return "synthetic_evidence_only";
  }
  if (
    isRuntimeGuidanceCandidate(claim) &&
    !resolved.some(isBehaviorallyReadable)
  ) {
    return "runtime_candidate_lacks_readable_behavior_evidence";
  }
  return null;
}

function isSyntheticEvidence(evidence: ContextPackEvidenceRef): boolean {
  const originPath = evidence.origin.path;
  if (!originPath) return false;
  return (
    originPath.includes("/.runweave/evidence/") ||
    originPath.startsWith("/tmp/runweave-") ||
    originPath.startsWith("/private/tmp/runweave-") ||
    originPath.includes("/runweave-evolution-dogfood-")
  );
}

function isRuntimeGuidanceCandidate(claim: EvolutionClaim): boolean {
  return (
    claim.candidateType === "memory" ||
    claim.candidateType === "prompt" ||
    claim.candidateType === "skill" ||
    claim.candidateType === "routing"
  );
}

function isBehaviorallyReadable(evidence: ContextPackEvidenceRef): boolean {
  if (evidence.source === "agent_team" || evidence.source === "app_server") {
    return true;
  }
  if (evidence.source !== "activity") return false;
  if (evidence.contentRefs.some((content) => content.availability === "available")) {
    return true;
  }
  const eventName = evidence.activity?.eventName ?? "";
  return (
    eventName.startsWith("agent_team.") ||
    eventName === "agent.lifecycle.observed" ||
    eventName === "browser.navigation.failed"
  );
}

function sameRunDuplicate(
  left: EvolutionClaim,
  right: EvolutionClaim,
): boolean {
  if (left.candidateType !== right.candidateType) return false;
  const leftEvidence = new Set(left.supportingEvidenceIds);
  const smallerEvidenceCount = Math.min(
    leftEvidence.size,
    right.supportingEvidenceIds.length,
  );
  if (smallerEvidenceCount === 0) return false;
  const overlap = right.supportingEvidenceIds.filter((evidenceId) =>
    leftEvidence.has(evidenceId),
  ).length;
  const evidenceOverlap = overlap / smallerEvidenceCount;
  return (
    evidenceOverlap >= 0.6 &&
    (statementSimilarity(left.statement, right.statement) >= 0.72 ||
      (overlap >= 2 && hasSharedTopicAnchor(left.topicKey, right.topicKey)))
  );
}

function hasSharedTopicAnchor(left: string, right: string): boolean {
  const rightTokens = topicTokens(right);
  return [...topicTokens(left)].some((token) => rightTokens.has(token));
}

function topicTokens(topicKey: string): Set<string> {
  return new Set(
    topicKey
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(
        (token) =>
          token.length >= 5 &&
          token !== "agent" &&
          token !== "analysis" &&
          token !== "evidence" &&
          token !== "result" &&
          token !== "workflow",
      ),
  );
}

function isDuplicateRepresentative(
  claim: EvolutionClaim,
  claims: EvolutionClaim[],
): boolean {
  const duplicates = claims
    .filter(
      (candidate) =>
        candidate.claimId === claim.claimId ||
        sameRunDuplicate(candidate, claim),
    )
    .sort(
      (left, right) =>
        right.supportingEvidenceIds.length - left.supportingEvidenceIds.length ||
        right.counterEvidenceIds.length - left.counterEvidenceIds.length ||
        left.claimId.localeCompare(right.claimId),
    );
  return duplicates[0]?.claimId === claim.claimId;
}

function bestSemanticMatch(
  claim: EvolutionClaim,
  entries: Array<{
    topicKey: string;
    revision: Insight["revisions"][number];
  }>,
): Insight["revisions"][number] | null {
  let best: Insight["revisions"][number] | null = null;
  let bestScore = 0;
  let evidenceMatch: Insight["revisions"][number] | null = null;
  for (const { topicKey, revision } of entries) {
    const score = statementSimilarity(claim.statement, revision.statement);
    if (score > bestScore) {
      best = revision;
      bestScore = score;
    }
    if (
      score < 0.72 &&
      hasStrongEvidenceOverlap(
        claim.supportingEvidenceIds,
        revision.evidenceIds,
      ) &&
      hasSharedTopicAnchor(claim.topicKey, topicKey)
    ) {
      evidenceMatch ??= revision;
    }
  }
  return bestScore >= 0.72 ? best : evidenceMatch;
}

function hasStrongEvidenceOverlap(
  left: string[],
  right: string[],
): boolean {
  const smallerEvidenceCount = Math.min(left.length, right.length);
  if (smallerEvidenceCount === 0) return false;
  const rightEvidence = new Set(right);
  const overlap = left.filter((evidenceId) =>
    rightEvidence.has(evidenceId),
  ).length;
  return overlap >= 2 && overlap / smallerEvidenceCount >= 0.6;
}

function statementSimilarity(left: string, right: string): number {
  const leftTokens = bigrams(normalizeForSimilarity(left));
  const rightTokens = bigrams(normalizeForSimilarity(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function normalizeForSimilarity(value: string): string {
  return normalize(value).replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(
    Array.from({ length: value.length - 1 }, (_, index) =>
      value.slice(index, index + 2),
    ),
  );
}
