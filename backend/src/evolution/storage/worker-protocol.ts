import type {
  CandidateAsset,
  ContributionEdge,
  ContextPackManifest,
  Episode,
  EvolutionAnalysisReport,
  EvolutionClaim,
  EvolutionClaimNovelty,
  EvolutionRun,
  EvolutionRunAttempt,
  EvolutionScopePolicy,
  EvolutionSchedule,
  EvolutionWatermark,
  Insight,
  InsightRevision,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
  TraceSegment,
} from "@runweave/shared/evolution";
import type {
  EvolutionEvidenceDependency,
  EvolutionEvidenceReconciliation,
  EvolutionRunKnowledgeCommit,
} from "../analysis-store";
import type {
  EvolutionDueScheduleMaterialization,
  EvolutionRunClaim,
  EvolutionRunListQuery,
  EvolutionRunTransition,
} from "../foundation-store";

export type EvolutionWorkerCommand =
  | { id: number; op: "list-candidates" }
  | { id: number; op: "put-candidate"; candidate: CandidateAsset }
  | { id: number; op: "get-policy"; learningScopeId: string }
  | { id: number; op: "put-policy"; policy: EvolutionScopePolicy }
  | { id: number; op: "put-trace"; trace: RuntimeTraceSummary }
  | { id: number; op: "append-trace-event"; event: RuntimeTraceEvent }
  | { id: number; op: "get-trace"; traceId: string }
  | { id: number; op: "list-traces"; runId: string }
  | {
      id: number;
      op: "list-recent-traces";
      learningScopeId?: string;
      limit: number;
    }
  | { id: number; op: "put-context-pack"; manifest: ContextPackManifest }
  | { id: number; op: "get-context-pack"; contextPackId: string }
  | { id: number; op: "get-context-pack-by-run"; runId: string }
  | { id: number; op: "put-trace-segments"; segments: TraceSegment[] }
  | { id: number; op: "list-trace-segments"; runId: string }
  | { id: number; op: "put-episodes"; episodes: Episode[] }
  | { id: number; op: "list-episodes"; runId: string }
  | { id: number; op: "put-analysis-report"; report: EvolutionAnalysisReport }
  | { id: number; op: "list-analysis-reports"; runId: string }
  | { id: number; op: "put-run-attempt"; attempt: EvolutionRunAttempt }
  | { id: number; op: "list-run-attempts"; runId: string }
  | { id: number; op: "put-claims"; claims: EvolutionClaim[] }
  | { id: number; op: "list-claims"; runId: string }
  | { id: number; op: "put-claim-novelty"; items: EvolutionClaimNovelty[] }
  | { id: number; op: "list-claim-novelty"; runId: string }
  | {
      id: number;
      op: "put-insight-revision";
      insight: Omit<Insight, "revisions">;
      revision: InsightRevision;
      contributionEdges: ContributionEdge[];
    }
  | { id: number; op: "list-insights"; learningScopeId?: string }
  | { id: number; op: "get-insight"; insightId: string }
  | { id: number; op: "list-insight-revisions-by-run"; runId: string }
  | { id: number; op: "list-evidence-dependencies" }
  | {
      id: number;
      op: "apply-evidence-reconciliation";
      reconciliation: EvolutionEvidenceReconciliation;
    }
  | {
      id: number;
      op: "commit-run-knowledge";
      params: EvolutionRunKnowledgeCommit;
    }
  | { id: number; op: "create-run"; run: EvolutionRun }
  | { id: number; op: "get-run"; runId: string }
  | { id: number; op: "list-runs"; query?: EvolutionRunListQuery }
  | {
      id: number;
      op: "claim-next-run";
      ownerId: string;
      now: string;
      leaseTtlMs: number;
    }
  | {
      id: number;
      op: "heartbeat-run-claim";
      ownerId: string;
      fencingToken: number;
      now: string;
      leaseTtlMs: number;
    }
  | { id: number; op: "transition-run"; transition: EvolutionRunTransition }
  | { id: number; op: "cancel-run"; runId: string; now: string }
  | { id: number; op: "recover-expired-runs"; now: string }
  | { id: number; op: "put-schedule"; schedule: EvolutionSchedule }
  | { id: number; op: "get-schedule"; scheduleId: string }
  | { id: number; op: "list-schedules"; learningScopeId?: string }
  | {
      id: number;
      op: "materialize-due-schedule";
      params: EvolutionDueScheduleMaterialization;
    }
  | { id: number; op: "delete-schedule"; scheduleId: string }
  | {
      id: number;
      op: "get-watermark";
      learningScopeId: string;
      source: string;
    }
  | {
      id: number;
      op: "put-watermark";
      watermark: EvolutionWatermark;
      ownerId: string;
      fencingToken: number;
      now: string;
    }
  | { id: number; op: "integrity" }
  | { id: number; op: "close" };

export type EvolutionWorkerRequest =
  EvolutionWorkerCommand extends infer Command
    ? Command extends { id: number }
      ? Omit<Command, "id">
      : never
    : never;

export type EvolutionWorkerResult =
  | CandidateAsset[]
  | ContributionEdge[]
  | ContextPackManifest
  | Episode[]
  | EvolutionAnalysisReport
  | EvolutionAnalysisReport[]
  | EvolutionClaim[]
  | EvolutionClaimNovelty[]
  | EvolutionEvidenceDependency[]
  | EvolutionRun
  | EvolutionRunAttempt[]
  | EvolutionRun[]
  | EvolutionRunClaim
  | EvolutionScopePolicy
  | EvolutionSchedule
  | EvolutionSchedule[]
  | EvolutionWatermark
  | Insight
  | Insight[]
  | InsightRevision[]
  | RuntimeTraceSummary
  | RuntimeTraceSummary[]
  | TraceSegment[]
  | boolean
  | number
  | string
  | null;

export type EvolutionWorkerResponse =
  | { id: number; ok: true; result: EvolutionWorkerResult }
  | { id: number; ok: false; error: string };
