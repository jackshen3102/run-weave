import type { EvolutionRunArtifacts } from "@runweave/shared/evolution";
import type { EvolutionAnalysisStore } from "./analysis-store";
import type { EvolutionActivationStore } from "./activation-store";

/** Reports and conclusions are shared by full exports and the lightweight UI view. */
export async function readRunConclusions(
  runId: string,
  analysisStore: EvolutionAnalysisStore | null,
  activationStore: EvolutionActivationStore | null,
): Promise<
  Omit<EvolutionRunArtifacts, "contextPack" | "segments" | "episodes">
> {
  if (!analysisStore)
    return {
      attempts: [],
      reports: [],
      claims: [],
      novelty: [],
      insightRevisions: [],
      candidateIds: [],
    };
  const [attempts, reports, claims, novelty, insightRevisions, candidates] =
    await Promise.all([
      analysisStore.listRunAttempts(runId),
      analysisStore.listAnalysisReports(runId),
      analysisStore.listClaims(runId),
      analysisStore.listClaimNovelty(runId),
      analysisStore.listInsightRevisionsByRun(runId),
      activationStore?.listCandidates() ?? [],
    ]);
  const revisionIds = new Set(
    insightRevisions.map((revision) => revision.revisionId),
  );
  return {
    attempts,
    reports,
    claims,
    novelty,
    insightRevisions,
    candidateIds: candidates
      .filter((candidate) => revisionIds.has(candidate.insightRevisionId))
      .map((candidate) => candidate.assetId),
  };
}
