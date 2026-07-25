import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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
import type { EvolutionActivationStore } from "../activation-store";
import type {
  EvolutionAnalysisStore,
  EvolutionEvidenceDependency,
  EvolutionEvidenceReconciliation,
  EvolutionRunKnowledgeCommit,
} from "../analysis-store";
import type { EvolutionContextPackStore } from "../context-pack-store";
import type {
  EvolutionDueScheduleMaterialization,
  EvolutionFoundationStore,
  EvolutionRunClaim,
  EvolutionRunListQuery,
  EvolutionRunTransition,
} from "../foundation-store";
import type {
  EvolutionWorkerRequest,
  EvolutionWorkerResponse,
  EvolutionWorkerResult,
} from "./worker-protocol";

interface PendingRequest {
  resolve: (value: EvolutionWorkerResult) => void;
  reject: (error: Error) => void;
}

const require = createRequire(import.meta.url);

function resolveWorkerEntry(env: NodeJS.ProcessEnv): URL {
  const configured = env.RUNWEAVE_EVOLUTION_WORKER_ENTRY?.trim();
  if (configured) return pathToFileURL(path.resolve(configured));
  const currentPath = fileURLToPath(import.meta.url);
  return new URL(
    currentPath.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js",
    import.meta.url,
  );
}

function createWorker(workerEntry: URL, databasePath: string): Worker {
  if (!workerEntry.pathname.endsWith(".ts")) {
    return new Worker(workerEntry, { workerData: { databasePath } });
  }
  const bootstrap = [
    `require(${JSON.stringify(require.resolve("tsx/cjs"))});`,
    `require(${JSON.stringify(fileURLToPath(workerEntry))});`,
  ].join("\n");
  return new Worker(bootstrap, {
    eval: true,
    workerData: { databasePath },
  });
}

export class SqliteEvolutionActivationStore
  implements
    EvolutionActivationStore,
    EvolutionFoundationStore,
    EvolutionContextPackStore,
    EvolutionAnalysisStore
{
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly workerExit: Promise<void>;
  private nextRequestId = 1;
  private closed = false;

  private constructor(databasePath: string, env: NodeJS.ProcessEnv) {
    this.worker = createWorker(resolveWorkerEntry(env), databasePath);
    let resolveWorkerExit: (() => void) | undefined;
    this.workerExit = new Promise<void>((resolve) => {
      resolveWorkerExit = resolve;
    });
    this.worker.on("message", (response: EvolutionWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    });
    this.worker.on("error", (error) => this.rejectAll(error));
    this.worker.on("exit", (code) => {
      resolveWorkerExit?.();
      if (!this.closed && code !== 0) {
        this.rejectAll(new Error(`evolution_sqlite_worker_exited:${code}`));
      }
    });
  }

  static async create(params: {
    databasePath: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<SqliteEvolutionActivationStore> {
    const store = new SqliteEvolutionActivationStore(
      params.databasePath,
      params.env ?? process.env,
    );
    if (!(await store.request<boolean>({ op: "integrity" }))) {
      await store.close();
      throw new Error("evolution_integrity_check_failed");
    }
    return store;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request<T extends EvolutionWorkerResult>(
    command: EvolutionWorkerRequest,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("evolution_store_closed"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ ...command, id });
    });
  }

  listCandidates(): Promise<CandidateAsset[]> {
    return this.request({ op: "list-candidates" });
  }

  async putCandidate(candidate: CandidateAsset): Promise<void> {
    await this.request({ op: "put-candidate", candidate });
  }

  getPolicy(learningScopeId: string): Promise<EvolutionScopePolicy | null> {
    return this.request({ op: "get-policy", learningScopeId });
  }

  async putPolicy(policy: EvolutionScopePolicy): Promise<void> {
    await this.request({ op: "put-policy", policy });
  }

  async putRuntimeTrace(trace: RuntimeTraceSummary): Promise<void> {
    await this.request({ op: "put-trace", trace });
  }

  async appendRuntimeTraceEvent(
    traceId: string,
    event: RuntimeTraceEvent,
  ): Promise<void> {
    if (event.traceId !== traceId)
      throw new Error("runtime_trace_event_mismatch");
    await this.request({ op: "append-trace-event", event });
  }

  getRuntimeTrace(traceId: string): Promise<RuntimeTraceSummary | null> {
    return this.request({ op: "get-trace", traceId });
  }

  listRuntimeTraces(runId: string): Promise<RuntimeTraceSummary[]> {
    return this.request({ op: "list-traces", runId });
  }

  listRecentRuntimeTraces(
    learningScopeId?: string,
    limit = 100,
  ): Promise<RuntimeTraceSummary[]> {
    return this.request({
      op: "list-recent-traces",
      learningScopeId,
      limit,
    });
  }

  async putContextPack(manifest: ContextPackManifest): Promise<void> {
    await this.request({ op: "put-context-pack", manifest });
  }

  getContextPack(contextPackId: string): Promise<ContextPackManifest | null> {
    return this.request({ op: "get-context-pack", contextPackId });
  }

  getContextPackByRun(runId: string): Promise<ContextPackManifest | null> {
    return this.request({ op: "get-context-pack-by-run", runId });
  }

  async putTraceSegments(segments: TraceSegment[]): Promise<void> {
    await this.request({ op: "put-trace-segments", segments });
  }

  listTraceSegments(runId: string): Promise<TraceSegment[]> {
    return this.request({ op: "list-trace-segments", runId });
  }

  async putEpisodes(episodes: Episode[]): Promise<void> {
    await this.request({ op: "put-episodes", episodes });
  }

  listEpisodes(runId: string): Promise<Episode[]> {
    return this.request({ op: "list-episodes", runId });
  }

  async putAnalysisReport(report: EvolutionAnalysisReport): Promise<void> {
    await this.request({ op: "put-analysis-report", report });
  }

  listAnalysisReports(runId: string): Promise<EvolutionAnalysisReport[]> {
    return this.request({ op: "list-analysis-reports", runId });
  }

  async putRunAttempt(attempt: EvolutionRunAttempt): Promise<void> {
    await this.request({ op: "put-run-attempt", attempt });
  }

  listRunAttempts(runId: string): Promise<EvolutionRunAttempt[]> {
    return this.request({ op: "list-run-attempts", runId });
  }

  async putClaims(claims: EvolutionClaim[]): Promise<void> {
    await this.request({ op: "put-claims", claims });
  }

  listClaims(runId: string): Promise<EvolutionClaim[]> {
    return this.request({ op: "list-claims", runId });
  }

  async putClaimNovelty(items: EvolutionClaimNovelty[]): Promise<void> {
    await this.request({ op: "put-claim-novelty", items });
  }

  listClaimNovelty(runId: string): Promise<EvolutionClaimNovelty[]> {
    return this.request({ op: "list-claim-novelty", runId });
  }

  async putInsightRevision(params: {
    insight: Omit<Insight, "revisions">;
    revision: InsightRevision;
    contributionEdges: ContributionEdge[];
  }): Promise<void> {
    await this.request({ op: "put-insight-revision", ...params });
  }

  listInsights(learningScopeId?: string): Promise<Insight[]> {
    return this.request({ op: "list-insights", learningScopeId });
  }

  getInsight(insightId: string): Promise<Insight | null> {
    return this.request({ op: "get-insight", insightId });
  }

  listInsightRevisionsByRun(runId: string): Promise<InsightRevision[]> {
    return this.request({ op: "list-insight-revisions-by-run", runId });
  }

  listEvidenceDependencies(): Promise<EvolutionEvidenceDependency[]> {
    return this.request({ op: "list-evidence-dependencies" });
  }

  async applyEvidenceReconciliation(
    reconciliation: EvolutionEvidenceReconciliation,
  ): Promise<void> {
    await this.request({ op: "apply-evidence-reconciliation", reconciliation });
  }

  commitRunKnowledge(
    params: EvolutionRunKnowledgeCommit,
  ): Promise<EvolutionRun> {
    return this.request({ op: "commit-run-knowledge", params });
  }

  async createRun(run: EvolutionRun): Promise<void> {
    await this.request({ op: "create-run", run });
  }

  getRun(runId: string): Promise<EvolutionRun | null> {
    return this.request({ op: "get-run", runId });
  }

  listRuns(query?: EvolutionRunListQuery): Promise<EvolutionRun[]> {
    return this.request({ op: "list-runs", query });
  }

  claimNextRun(params: {
    ownerId: string;
    now: string;
    leaseTtlMs: number;
  }): Promise<EvolutionRunClaim | null> {
    return this.request({ op: "claim-next-run", ...params });
  }

  heartbeatRunClaim(params: {
    ownerId: string;
    fencingToken: number;
    now: string;
    leaseTtlMs: number;
  }): Promise<string> {
    return this.request({ op: "heartbeat-run-claim", ...params });
  }

  transitionRun(transition: EvolutionRunTransition): Promise<EvolutionRun> {
    return this.request({ op: "transition-run", transition });
  }

  cancelRun(runId: string, now: string): Promise<EvolutionRun> {
    return this.request({ op: "cancel-run", runId, now });
  }

  recoverExpiredRuns(now: string): Promise<number> {
    return this.request({ op: "recover-expired-runs", now });
  }

  async putSchedule(schedule: EvolutionSchedule): Promise<void> {
    await this.request({ op: "put-schedule", schedule });
  }

  getSchedule(scheduleId: string): Promise<EvolutionSchedule | null> {
    return this.request({ op: "get-schedule", scheduleId });
  }

  listSchedules(learningScopeId?: string): Promise<EvolutionSchedule[]> {
    return this.request({ op: "list-schedules", learningScopeId });
  }

  materializeDueSchedule(
    params: EvolutionDueScheduleMaterialization,
  ): Promise<boolean> {
    return this.request({ op: "materialize-due-schedule", params });
  }

  deleteSchedule(scheduleId: string): Promise<boolean> {
    return this.request({ op: "delete-schedule", scheduleId });
  }

  getWatermark(
    learningScopeId: string,
    source: string,
  ): Promise<EvolutionWatermark | null> {
    return this.request({ op: "get-watermark", learningScopeId, source });
  }

  async putWatermark(params: {
    watermark: EvolutionWatermark;
    ownerId: string;
    fencingToken: number;
    now: string;
  }): Promise<void> {
    await this.request({ op: "put-watermark", ...params });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.request({ op: "close" }).catch(() => undefined);
    this.closed = true;
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.workerExit.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2_000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited) await this.worker.terminate();
    this.rejectAll(new Error("evolution_store_closed"));
  }
}
