import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
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
import { EvolutionArtifactDatabase } from "./artifact-database";
import { EvolutionFoundationDatabase } from "./foundation-database";
import { EvolutionKnowledgeDatabase } from "./knowledge-database";
import { migrateEvolutionDatabase } from "./migrations";

export class EvolutionActivationDatabase {
  private readonly database: Database.Database;
  private readonly foundation: EvolutionFoundationDatabase;
  private readonly artifacts: EvolutionArtifactDatabase;
  private readonly knowledge: EvolutionKnowledgeDatabase;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    migrateEvolutionDatabase(this.database);
    this.foundation = new EvolutionFoundationDatabase(this.database);
    this.artifacts = new EvolutionArtifactDatabase(this.database);
    this.knowledge = new EvolutionKnowledgeDatabase(
      this.database,
      this.foundation,
    );
  }

  getPolicy(learningScopeId: string): EvolutionScopePolicy | null {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM evolution_policies WHERE learning_scope_id = ?",
      )
      .get(learningScopeId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as EvolutionScopePolicy) : null;
  }

  putPolicy(policy: EvolutionScopePolicy): void {
    const result = this.database
      .prepare(
        `INSERT INTO evolution_policies (learning_scope_id, revision, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(learning_scope_id) DO UPDATE SET
           revision = excluded.revision,
           payload_json = excluded.payload_json
         WHERE excluded.revision > evolution_policies.revision`,
      )
      .run(policy.learningScopeId, policy.revision, JSON.stringify(policy));
    if (result.changes !== 1) {
      throw new Error("evolution_policy_revision_conflict");
    }
  }

  listCandidates(): CandidateAsset[] {
    return this.knowledge.listCandidates();
  }

  putCandidate(candidate: CandidateAsset): void {
    this.knowledge.putCandidate(candidate);
  }

  putRuntimeTrace(trace: RuntimeTraceSummary): void {
    this.artifacts.putRuntimeTrace(trace);
  }

  appendRuntimeTraceEvent(event: RuntimeTraceEvent): void {
    this.artifacts.appendRuntimeTraceEvent(event);
  }

  getRuntimeTrace(traceId: string): RuntimeTraceSummary | null {
    return this.artifacts.getRuntimeTrace(traceId);
  }

  listRuntimeTraces(runId: string): RuntimeTraceSummary[] {
    return this.artifacts.listRuntimeTraces(runId);
  }

  listRecentRuntimeTraces(
    learningScopeId: string | undefined,
    limit: number,
  ): RuntimeTraceSummary[] {
    return this.artifacts.listRecentRuntimeTraces(learningScopeId, limit);
  }

  putContextPack(manifest: ContextPackManifest): void {
    this.artifacts.putContextPack(manifest);
  }

  getContextPack(contextPackId: string): ContextPackManifest | null {
    return this.artifacts.getContextPack(contextPackId);
  }

  getContextPackByRun(runId: string): ContextPackManifest | null {
    return this.artifacts.getContextPackByRun(runId);
  }

  putTraceSegments(segments: TraceSegment[]): void {
    this.artifacts.putTraceSegments(segments);
  }

  listTraceSegments(runId: string): TraceSegment[] {
    return this.artifacts.listTraceSegments(runId);
  }

  putEpisodes(episodes: Episode[]): void {
    this.artifacts.putEpisodes(episodes);
  }

  listEpisodes(runId: string): Episode[] {
    return this.artifacts.listEpisodes(runId);
  }

  putAnalysisReport(report: EvolutionAnalysisReport): void {
    this.artifacts.putAnalysisReport(report);
  }

  listAnalysisReports(runId: string): EvolutionAnalysisReport[] {
    return this.artifacts.listAnalysisReports(runId);
  }

  putRunAttempt(attempt: EvolutionRunAttempt): void {
    this.artifacts.putRunAttempt(attempt);
  }

  listRunAttempts(runId: string): EvolutionRunAttempt[] {
    return this.artifacts.listRunAttempts(runId);
  }

  putClaims(claims: EvolutionClaim[]): void {
    this.artifacts.putClaims(claims);
  }

  listClaims(runId: string): EvolutionClaim[] {
    return this.artifacts.listClaims(runId);
  }

  putClaimNovelty(items: EvolutionClaimNovelty[]): void {
    this.artifacts.putClaimNovelty(items);
  }

  listClaimNovelty(runId: string): EvolutionClaimNovelty[] {
    return this.artifacts.listClaimNovelty(runId);
  }

  putInsightRevision(params: {
    insight: Omit<Insight, "revisions">;
    revision: InsightRevision;
    contributionEdges: ContributionEdge[];
  }): void {
    this.knowledge.putInsightRevision(params);
  }

  listInsights(learningScopeId?: string): Insight[] {
    return this.knowledge.listInsights(learningScopeId);
  }

  getInsight(insightId: string): Insight | null {
    return this.knowledge.getInsight(insightId);
  }

  listInsightRevisionsByRun(runId: string): InsightRevision[] {
    return this.knowledge.listInsightRevisionsByRun(runId);
  }

  listEvidenceDependencies(): EvolutionEvidenceDependency[] {
    return this.knowledge.listEvidenceDependencies();
  }

  applyEvidenceReconciliation(
    reconciliation: EvolutionEvidenceReconciliation,
  ): void {
    this.knowledge.applyEvidenceReconciliation(reconciliation);
  }

  commitRunKnowledge(params: EvolutionRunKnowledgeCommit): EvolutionRun {
    return this.knowledge.commitRunKnowledge(params);
  }

  private finishRunningAttempts(
    runId: string,
    status: Extract<EvolutionRunAttempt["status"], "cancelled">,
    completedAt: string,
  ): void {
    this.database
      .prepare(
        `UPDATE evolution_run_attempts
         SET status = ?, completed_at = ?,
             payload_json = json_set(
               payload_json,
               '$.status', ?,
               '$.completedAt', ?,
               '$.errorCode', ?
             )
         WHERE run_id = ? AND status = 'running'`,
      )
      .run(status, completedAt, status, completedAt, "run_cancelled", runId);
  }

  createRun(run: EvolutionRun): void {
    this.foundation.createRun(run);
  }

  getRun(runId: string): EvolutionRun | null {
    return this.foundation.getRun(runId);
  }

  listRuns(query?: EvolutionRunListQuery): EvolutionRun[] {
    return this.foundation.listRuns(query);
  }

  claimNextRun(params: {
    ownerId: string;
    now: string;
    leaseTtlMs: number;
  }): EvolutionRunClaim | null {
    return this.foundation.claimNextRun(params);
  }

  heartbeatRunClaim(params: {
    ownerId: string;
    fencingToken: number;
    now: string;
    leaseTtlMs: number;
  }): string {
    return this.foundation.heartbeatRunClaim(params);
  }

  transitionRun(transition: EvolutionRunTransition): EvolutionRun {
    return this.foundation.transitionRun(transition);
  }

  cancelRun(runId: string, now: string): EvolutionRun {
    const run = this.foundation.cancelRun(runId, now);
    this.finishRunningAttempts(runId, "cancelled", now);
    return run;
  }

  recoverExpiredRuns(now: string): number {
    const recovered = this.foundation.recoverExpiredRuns(now);
    if (recovered > 0) {
      this.database
        .prepare(
          `UPDATE evolution_run_attempts
           SET status = 'abandoned', completed_at = ?,
               payload_json = json_set(
                 payload_json,
                 '$.status', 'abandoned',
                 '$.completedAt', ?,
                 '$.errorCode', 'backend_recovered_unknown_call'
               )
           WHERE status = 'running'
             AND run_id IN (
               SELECT run_id FROM evolution_runs WHERE stage = 'queued'
             )`,
        )
        .run(now, now);
    }
    return recovered;
  }

  putSchedule(schedule: EvolutionSchedule): void {
    this.foundation.putSchedule(schedule);
  }

  getSchedule(scheduleId: string): EvolutionSchedule | null {
    return this.foundation.getSchedule(scheduleId);
  }

  listSchedules(learningScopeId?: string): EvolutionSchedule[] {
    return this.foundation.listSchedules(learningScopeId);
  }

  materializeDueSchedule(params: EvolutionDueScheduleMaterialization): boolean {
    return this.foundation.materializeDueSchedule(params);
  }

  deleteSchedule(scheduleId: string): boolean {
    return this.foundation.deleteSchedule(scheduleId);
  }

  getWatermark(
    learningScopeId: string,
    source: string,
  ): EvolutionWatermark | null {
    return this.foundation.getWatermark(learningScopeId, source);
  }

  putWatermark(params: {
    watermark: EvolutionWatermark;
    ownerId: string;
    fencingToken: number;
    now: string;
  }): void {
    this.foundation.putWatermark(params);
  }

  integrity(): boolean {
    const result = this.database.pragma("quick_check") as Array<{
      quick_check: string;
    }>;
    return result.every((row) => row.quick_check === "ok");
  }

  close(): void {
    this.database.close();
  }
}
