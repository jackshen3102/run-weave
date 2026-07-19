import type {
  CandidateAsset,
  EvolutionMemoryQuery,
  EvolutionScopePolicy,
  EvolutionSelectionDecision,
} from "@runweave/shared/evolution";

export interface HardFilterResult {
  eligible: CandidateAsset[];
  filtered: Array<{ revisionId: string; reason: string }>;
}

export interface EvolutionMemorySelector {
  readonly version: string;
  select(
    query: EvolutionMemoryQuery,
    candidates: CandidateAsset[],
  ): Promise<EvolutionSelectionDecision[]>;
}

function includesTerm(values: string[], terms: string[]): boolean {
  return terms.some((term) =>
    values.some((value) =>
      value.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
    ),
  );
}

function exclusionReason(
  candidate: CandidateAsset,
  query: EvolutionMemoryQuery,
): string | null {
  const taskText = `${query.task}\n${query.intent}`;
  if (includesTerm([taskText], candidate.exclusions.taskTerms ?? [])) {
    return "task_exclusion";
  }
  if (includesTerm(query.paths, candidate.exclusions.pathPrefixes ?? [])) {
    return "path_exclusion";
  }
  if (
    includesTerm(
      query.failureSignatures,
      candidate.exclusions.failureSignatures ?? [],
    )
  ) {
    return "failure_signature_exclusion";
  }
  return null;
}

function dependencyMismatch(
  candidate: CandidateAsset,
  query: EvolutionMemoryQuery,
): boolean {
  return Object.entries(candidate.dependencies).some(([key, expected]) => {
    if (expected == null) return false;
    const actual = query.dependencies[key as keyof typeof query.dependencies];
    return actual !== expected;
  });
}

export function hardFilterMemoryCandidates(
  candidates: CandidateAsset[],
  query: EvolutionMemoryQuery,
  policy: EvolutionScopePolicy,
  nowMs: number = Date.now(),
): HardFilterResult {
  const eligible: CandidateAsset[] = [];
  const filtered: HardFilterResult["filtered"] = [];
  for (const candidate of candidates) {
    let reason: string | null = null;
    if (candidate.type !== "memory") reason = "non_memory_asset";
    else if (candidate.learningScopeId !== query.learningScopeId)
      reason = "learning_scope_mismatch";
    else if (!candidate.applicability.workerRoles.includes(query.workerRole))
      reason = "worker_role_mismatch";
    else if (
      candidate.lifecycle !== "canary" &&
      candidate.lifecycle !== "promoted"
    )
      reason = "lifecycle_not_injectable";
    else if (Date.parse(candidate.validFrom) > nowMs) reason = "not_yet_valid";
    else if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= nowMs)
      reason = "expired";
    else if (dependencyMismatch(candidate, query))
      reason = "dependency_mismatch";
    else reason = exclusionReason(candidate, query);
    if (reason) {
      filtered.push({ revisionId: candidate.revisionId, reason });
    } else if (policy.memoryCanaryEnabled) {
      eligible.push(candidate);
    } else {
      filtered.push({
        revisionId: candidate.revisionId,
        reason: "policy_disabled",
      });
    }
  }
  return { eligible, filtered };
}

function relevance(
  candidate: CandidateAsset,
  query: EvolutionMemoryQuery,
): number {
  const taskText = `${query.task}\n${query.intent}`;
  let score = 0;
  const applicability = candidate.applicability;
  if (includesTerm([taskText], applicability.taskTerms ?? [])) score += 3;
  if (includesTerm(query.paths, applicability.pathPrefixes ?? [])) score += 3;
  if (includesTerm(query.commands, applicability.commandTerms ?? []))
    score += 2;
  if (
    includesTerm(query.failureSignatures, applicability.failureSignatures ?? [])
  ) {
    score += 3;
  }
  const hasSpecificMatcher =
    (applicability.taskTerms?.length ?? 0) +
      (applicability.pathPrefixes?.length ?? 0) +
      (applicability.commandTerms?.length ?? 0) +
      (applicability.failureSignatures?.length ?? 0) >
    0;
  return hasSpecificMatcher ? score : 1;
}

export class StructuredEvolutionMemorySelector implements EvolutionMemorySelector {
  readonly version = "structured-selector-v1";

  async select(
    query: EvolutionMemoryQuery,
    candidates: CandidateAsset[],
  ): Promise<EvolutionSelectionDecision[]> {
    return candidates
      .map((candidate) => {
        const score = relevance(candidate, query);
        return {
          assetId: candidate.assetId,
          revisionId: candidate.revisionId,
          selected: score > 0,
          reason:
            score > 0
              ? `structured_match_score:${score}`
              : "no_high_confidence_match",
          confidence: Math.min(0.99, score > 0 ? 0.7 + score * 0.05 : 0),
        };
      })
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.revisionId.localeCompare(right.revisionId),
      );
  }
}
