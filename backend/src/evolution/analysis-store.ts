import type {
  CandidateAsset,
  ContributionEdge,
  Episode,
  EvolutionAnalysisReport,
  EvolutionClaim,
  EvolutionClaimNovelty,
  EvolutionRunAttempt,
  Insight,
  InsightRevision,
  TraceSegment,
  EvolutionRun,
  EvolutionWatermark,
} from "@runweave/shared/evolution";

export interface EvolutionPreparedInsightRevision {
  insight: Omit<Insight, "revisions">;
  revision: InsightRevision;
  contributionEdges: ContributionEdge[];
}

export interface EvolutionRunKnowledgeCommit {
  runId: string;
  ownerId: string;
  fencingToken: number;
  now: string;
  outcome: Extract<
    EvolutionRun["outcome"],
    "completed" | "no_material_novelty"
  >;
  insights: EvolutionPreparedInsightRevision[];
  candidates: CandidateAsset[];
  watermark: EvolutionWatermark | null;
}

export interface EvolutionEvidenceDependency {
  insight: Omit<Insight, "revisions">;
  revision: InsightRevision;
  contributionEdges: ContributionEdge[];
  candidates: CandidateAsset[];
}

export interface EvolutionEvidenceReconciliation {
  insights: EvolutionPreparedInsightRevision[];
  candidates: CandidateAsset[];
}

export interface EvolutionAnalysisStore {
  putTraceSegments(segments: TraceSegment[]): Promise<void>;
  listTraceSegments(runId: string): Promise<TraceSegment[]>;
  putEpisodes(episodes: Episode[]): Promise<void>;
  listEpisodes(runId: string): Promise<Episode[]>;
  putAnalysisReport(report: EvolutionAnalysisReport): Promise<void>;
  listAnalysisReports(runId: string): Promise<EvolutionAnalysisReport[]>;
  putRunAttempt(attempt: EvolutionRunAttempt): Promise<void>;
  listRunAttempts(runId: string): Promise<EvolutionRunAttempt[]>;
  putClaims(claims: EvolutionClaim[]): Promise<void>;
  listClaims(runId: string): Promise<EvolutionClaim[]>;
  putClaimNovelty(items: EvolutionClaimNovelty[]): Promise<void>;
  listClaimNovelty(runId: string): Promise<EvolutionClaimNovelty[]>;
  putInsightRevision(params: {
    insight: Omit<Insight, "revisions">;
    revision: InsightRevision;
    contributionEdges: ContributionEdge[];
  }): Promise<void>;
  listInsights(learningScopeId?: string): Promise<Insight[]>;
  getInsight(insightId: string): Promise<Insight | null>;
  listInsightRevisionsByRun(runId: string): Promise<InsightRevision[]>;
  listEvidenceDependencies(): Promise<EvolutionEvidenceDependency[]>;
  applyEvidenceReconciliation(
    reconciliation: EvolutionEvidenceReconciliation,
  ): Promise<void>;
  commitRunKnowledge(
    params: EvolutionRunKnowledgeCommit,
  ): Promise<EvolutionRun>;
}
