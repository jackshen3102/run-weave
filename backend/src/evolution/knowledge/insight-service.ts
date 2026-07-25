import { createHash } from "node:crypto";
import type {
  CandidateAsset,
  ContributionEdge,
  EvolutionClaim,
  EvolutionClaimNovelty,
  Insight,
  InsightRevision,
} from "@runweave/shared/evolution";
import type {
  EvolutionAnalysisStore,
  EvolutionPreparedInsightRevision,
} from "../analysis-store";
import { createCandidateAsset } from "./candidate-factory";

const MATERIAL_CANDIDATE_NOVELTY = new Set([
  "novel",
  "contradiction",
  "drift",
]);

export interface CommitKnowledgeResult {
  insights: EvolutionPreparedInsightRevision[];
  revisions: InsightRevision[];
  candidates: CandidateAsset[];
}

export class EvolutionInsightService {
  constructor(private readonly analysisStore: EvolutionAnalysisStore) {}

  async prepare(params: {
    runId: string;
    learningScopeId: string;
    claims: EvolutionClaim[];
    novelty: EvolutionClaimNovelty[];
    createdAt: string;
  }): Promise<CommitKnowledgeResult> {
    const baseline = await this.analysisStore.listInsights(
      params.learningScopeId,
    );
    const baselineByTopic = new Map(
      baseline.map((insight) => [insight.topicKey, insight]),
    );
    const noveltyByClaim = new Map(
      params.novelty.map((item) => [item.claimId, item]),
    );
    const revisions: InsightRevision[] = [];
    const insights: EvolutionPreparedInsightRevision[] = [];
    const candidates: CandidateAsset[] = [];
    for (const claim of params.claims) {
      const novelty = noveltyByClaim.get(claim.claimId);
      if (
        claim.status !== "corroborated" ||
        !novelty ||
        novelty.novelty === "known"
      ) {
        continue;
      }
      const existing = baselineByTopic.get(claim.topicKey);
      const insightId =
        existing?.insightId ??
        stableId("insight", [params.learningScopeId, claim.topicKey]);
      const revision: InsightRevision = {
        revisionId: stableId("irev", [
          insightId,
          claim.statement,
          claim.scope,
          ...claim.supportingEvidenceIds,
          ...claim.counterEvidenceIds,
        ]),
        insightId,
        runId: params.runId,
        statement: claim.statement,
        scope: claim.scope,
        confidence: claim.counterEvidenceIds.length > 0 ? 0.7 : 0.85,
        novelty: novelty.novelty,
        claimIds: [claim.claimId],
        evidenceIds: [...claim.supportingEvidenceIds],
        counterEvidenceIds: [...claim.counterEvidenceIds],
        createdAt: params.createdAt,
      };
      const insight: Omit<Insight, "revisions"> = {
        insightId,
        learningScopeId: params.learningScopeId,
        topicKey: claim.topicKey,
        currentRevisionId: revision.revisionId,
        createdAt: existing?.createdAt ?? params.createdAt,
        updatedAt: params.createdAt,
      };
      const contributionEdges = toContributionEdges(revision);
      insights.push({
        insight,
        revision,
        contributionEdges,
      });
      revisions.push(revision);

      if (
        MATERIAL_CANDIDATE_NOVELTY.has(novelty.novelty) &&
        claim.candidateType &&
        claim.guidance
      ) {
        const candidate = createCandidateAsset(
          {
            type: claim.candidateType,
            learningScopeId: params.learningScopeId,
            insightRevisionId: revision.revisionId,
            statement: claim.statement,
            guidance: claim.guidance,
            rationale: `${novelty.novelty}:${claim.status}`,
            evidenceRefs: claim.supportingEvidenceIds,
            counterEvidenceRefs: claim.counterEvidenceIds,
            applicability: { workerRoles: ["code"] },
            risk: claim.risk,
          },
          params.createdAt,
        );
        candidates.push(candidate);
      }
    }
    return { insights, revisions, candidates };
  }
}

function toContributionEdges(
  revision: InsightRevision,
): ContributionEdge[] {
  return [
    ...revision.evidenceIds.map((evidenceId) =>
      edge(revision, evidenceId, "supports"),
    ),
    ...revision.counterEvidenceIds.map((evidenceId) =>
      edge(revision, evidenceId, "counters"),
    ),
  ];
}

function edge(
  revision: InsightRevision,
  evidenceId: string,
  relation: ContributionEdge["relation"],
): ContributionEdge {
  return {
    edgeId: stableId("edge", [revision.revisionId, evidenceId, relation]),
    insightRevisionId: revision.revisionId,
    evidenceId,
    relation,
    availability: "available",
    createdAt: revision.createdAt,
  };
}

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}
