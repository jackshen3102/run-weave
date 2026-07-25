import crypto from "node:crypto";
import {
  EVOLUTION_GLOBAL_SCOPE_ID,
  type AnalysisProfile,
  type CreateEvolutionRunRequest,
  type CreateEvolutionScheduleRequest,
  type EvolutionBudget,
  type EvolutionProviderAvailability,
  type EvolutionRun,
  type EvolutionRunArtifacts,
  type EvolutionRunStage,
  type EvolutionSchedule,
  type Insight,
  type ProviderPolicy,
  type UpdateEvolutionScheduleRequest,
} from "@runweave/shared/evolution";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import type { EvolutionActivationStore } from "./activation-store";
import type { EvolutionAnalysisStore } from "./analysis-store";
import type { EvolutionContextPackStore } from "./context-pack-store";
import type {
  EvolutionFoundationStore,
  EvolutionRunListQuery,
} from "./foundation-store";
import {
  latestCronOccurrenceAtOrBefore,
  nextCronOccurrence,
  validateCronExpression,
} from "./cron";
import { EvolutionProviderAvailabilityService } from "./providers/availability";

const DEFAULT_PROFILE: AnalysisProfile = "standard";
const DEFAULT_PROVIDER_POLICY: ProviderPolicy = "auto";

export class EvolutionService {
  constructor(
    private readonly store: EvolutionFoundationStore | null,
    private readonly now: () => Date = () => new Date(),
    private readonly providerAvailability = new EvolutionProviderAvailabilityService(),
    private readonly analysisStore: EvolutionAnalysisStore | null = null,
    private readonly contextPackStore: EvolutionContextPackStore | null = null,
    private readonly activationStore: EvolutionActivationStore | null = null,
  ) {}

  isAvailable(): boolean {
    return this.store !== null;
  }

  async createManualRun(
    request: CreateEvolutionRunRequest,
    requestedBy: string,
  ): Promise<EvolutionRun> {
    const now = this.now().toISOString();
    const store = this.requireStore();
    const learningScopeId = resolveLearningScopeId(request);
    const requestedAfterWatermark = request.dataRange?.afterWatermark;
    const storedWatermark =
      requestedAfterWatermark === undefined
        ? await store.getWatermark(learningScopeId, "activity")
        : null;
    const run: EvolutionRun = {
      runId: crypto.randomUUID(),
      learningScopeId,
      trigger: { type: "manual", requestedBy },
      profile: request.profile ?? DEFAULT_PROFILE,
      providerPolicy: request.providerPolicy ?? DEFAULT_PROVIDER_POLICY,
      budget: mergeBudget(request.profile ?? DEFAULT_PROFILE, request.budget),
      dataRange: {
        afterWatermark:
          requestedAfterWatermark === undefined
            ? (storedWatermark?.value ?? null)
            : requestedAfterWatermark,
        atOrBefore: request.dataRange?.atOrBefore ?? now,
      },
      stage: "queued",
      outcome: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      attempt: 0,
    };
    await store.createRun(run);
    return run;
  }

  getRun(runId: string): Promise<EvolutionRun | null> {
    return this.requireStore().getRun(runId);
  }

  listRuns(query?: EvolutionRunListQuery): Promise<EvolutionRun[]> {
    return this.requireStore().listRuns(query);
  }

  cancelRun(runId: string): Promise<EvolutionRun> {
    return this.requireStore().cancelRun(runId, this.now().toISOString());
  }

  async retryRun(runId: string, requestedBy: string): Promise<EvolutionRun> {
    const previous = await this.requireRun(runId);
    if (!isTerminalStage(previous.stage)) {
      throw new Error("evolution_run_not_retryable");
    }
    return this.createManualRun(
      {
        projectId: previous.learningScopeId,
        profile: previous.profile,
        providerPolicy: previous.providerPolicy,
        budget: previous.budget,
        dataRange: previous.dataRange,
      },
      requestedBy,
    );
  }

  listProviders(): Promise<EvolutionProviderAvailability[]> {
    return this.providerAvailability.list();
  }

  async getRunArtifacts(runId: string): Promise<EvolutionRunArtifacts> {
    await this.requireRun(runId);
    if (!this.analysisStore) {
      return {
        contextPack: null,
        segments: [],
        episodes: [],
        attempts: [],
        reports: [],
        claims: [],
        novelty: [],
        insightRevisions: [],
        candidateIds: [],
      };
    }
    const [
      contextPack,
      segments,
      episodes,
      attempts,
      reports,
      claims,
      novelty,
      insightRevisions,
      candidates,
    ] = await Promise.all([
      this.contextPackStore?.getContextPackByRun(runId) ?? null,
      this.analysisStore.listTraceSegments(runId),
      this.analysisStore.listEpisodes(runId),
      this.analysisStore.listRunAttempts(runId),
      this.analysisStore.listAnalysisReports(runId),
      this.analysisStore.listClaims(runId),
      this.analysisStore.listClaimNovelty(runId),
      this.analysisStore.listInsightRevisionsByRun(runId),
      this.activationStore?.listCandidates() ?? [],
    ]);
    const revisionIds = new Set(
      insightRevisions.map((revision) => revision.revisionId),
    );
    return {
      contextPack,
      segments,
      episodes,
      attempts,
      reports,
      claims,
      novelty,
      insightRevisions,
      candidateIds: candidates
        .filter((candidate) =>
          revisionIds.has(candidate.insightRevisionId),
        )
        .map((candidate) => candidate.assetId),
    };
  }

  listInsights(learningScopeId?: string): Promise<Insight[]> {
    if (!this.analysisStore) return Promise.resolve([]);
    return this.analysisStore.listInsights(learningScopeId);
  }

  getInsight(insightId: string): Promise<Insight | null> {
    if (!this.analysisStore) return Promise.resolve(null);
    return this.analysisStore.getInsight(insightId);
  }

  async createSchedule(
    request: CreateEvolutionScheduleRequest,
  ): Promise<EvolutionSchedule> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const profile = request.profile ?? DEFAULT_PROFILE;
    const cronExpression = request.cronExpression.trim();
    const timezone = request.timezone.trim();
    const enabled = request.enabled ?? true;
    validateCronExpression(cronExpression);
    const schedule: EvolutionSchedule = {
      scheduleId: crypto.randomUUID(),
      learningScopeId: resolveLearningScopeId(request.projectId),
      name: request.name.trim(),
      cronExpression,
      timezone,
      enabled,
      profile,
      providerPolicy: request.providerPolicy ?? DEFAULT_PROVIDER_POLICY,
      budget: mergeBudget(profile, request.budget),
      dataWindow: request.dataWindow?.trim() || "since_last_success",
      nextDueAt: enabled
        ? nextCronOccurrence(cronExpression, timezone, nowDate).toISOString()
        : null,
      lastDueAt: null,
      lastRunId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.requireStore().putSchedule(schedule);
    return schedule;
  }

  async updateSchedule(
    scheduleId: string,
    request: UpdateEvolutionScheduleRequest,
  ): Promise<EvolutionSchedule> {
    const current = await this.requireSchedule(scheduleId);
    const nowDate = this.now();
    const profile = request.profile ?? current.profile;
    const schedule: EvolutionSchedule = {
      ...current,
      ...(request.name === undefined ? {} : { name: request.name.trim() }),
      ...(request.cronExpression === undefined
        ? {}
        : { cronExpression: request.cronExpression.trim() }),
      ...(request.timezone === undefined
        ? {}
        : { timezone: request.timezone.trim() }),
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      profile,
      providerPolicy: request.providerPolicy ?? current.providerPolicy,
      budget:
        request.budget === undefined
          ? current.budget
          : { ...current.budget, ...request.budget },
      ...(request.dataWindow === undefined
        ? {}
        : { dataWindow: request.dataWindow.trim() }),
      updatedAt: nowDate.toISOString(),
    };
    validateCronExpression(schedule.cronExpression);
    schedule.nextDueAt = schedule.enabled
      ? nextCronOccurrence(
          schedule.cronExpression,
          schedule.timezone,
          nowDate,
        ).toISOString()
      : null;
    await this.requireStore().putSchedule(schedule);
    return schedule;
  }

  listSchedules(learningScopeId?: string): Promise<EvolutionSchedule[]> {
    return this.requireStore().listSchedules(learningScopeId);
  }

  async materializeDueSchedules(
    at: Date = this.now(),
  ): Promise<EvolutionRun[]> {
    const store = this.requireStore();
    const now = at.toISOString();
    const schedules = await store.listSchedules();
    const materialized: EvolutionRun[] = [];
    for (const schedule of schedules) {
      if (
        !schedule.enabled ||
        !schedule.nextDueAt ||
        Date.parse(schedule.nextDueAt) > at.getTime()
      ) {
        continue;
      }
      const dueAt = latestCronOccurrenceAtOrBefore(
        schedule.cronExpression,
        schedule.timezone,
        at,
      ).toISOString();
      const runId = crypto.randomUUID();
      const watermark = await store.getWatermark(
        schedule.learningScopeId,
        "activity",
      );
      const run: EvolutionRun = {
        runId,
        learningScopeId: schedule.learningScopeId,
        trigger: {
          type: "schedule",
          scheduleId: schedule.scheduleId,
          dueAt,
        },
        profile: schedule.profile,
        providerPolicy: schedule.providerPolicy,
        budget: schedule.budget,
        dataRange: {
          afterWatermark: watermark?.value ?? null,
          atOrBefore: now,
        },
        stage: "queued",
        outcome: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        attempt: 0,
      };
      const nextSchedule: EvolutionSchedule = {
        ...schedule,
        nextDueAt: nextCronOccurrence(
          schedule.cronExpression,
          schedule.timezone,
          new Date(dueAt),
        ).toISOString(),
        lastDueAt: dueAt,
        lastRunId: runId,
        updatedAt: now,
      };
      const created = await store.materializeDueSchedule({
        scheduleId: schedule.scheduleId,
        expectedNextDueAt: schedule.nextDueAt,
        now,
        run,
        nextSchedule,
      });
      if (created) materialized.push(run);
    }
    return materialized;
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    if (!(await this.requireStore().deleteSchedule(scheduleId))) {
      throw new Error("evolution_schedule_not_found");
    }
  }

  private requireStore(): EvolutionFoundationStore {
    if (!this.store) throw new Error("evolution_unavailable");
    return this.store;
  }

  private async requireRun(runId: string): Promise<EvolutionRun> {
    const run = await this.requireStore().getRun(runId);
    if (!run) throw new Error("evolution_run_not_found");
    return run;
  }

  private async requireSchedule(
    scheduleId: string,
  ): Promise<EvolutionSchedule> {
    const schedule = await this.requireStore().getSchedule(scheduleId);
    if (!schedule) throw new Error("evolution_schedule_not_found");
    return schedule;
  }
}

export function defaultEvolutionBudget(
  profile: AnalysisProfile,
): EvolutionBudget {
  if (profile === "quick") {
    return {
      maxAgents: 1,
      maxModelTurns: 4,
      maxWallTimeMs: 5 * 60_000,
      maxContextBytes: 500_000,
      maxToolCalls: 20,
      maxReplays: 0,
    };
  }
  if (profile === "deep") {
    return {
      maxAgents: 3,
      maxModelTurns: 16,
      maxWallTimeMs: 45 * 60_000,
      maxContextBytes: 2_000_000,
      maxToolCalls: 120,
      maxReplays: 3,
    };
  }
  return {
    maxAgents: 2,
    maxModelTurns: 10,
    maxWallTimeMs: 20 * 60_000,
    maxContextBytes: 1_000_000,
    maxToolCalls: 60,
    maxReplays: 0,
  };
}

function mergeBudget(
  profile: AnalysisProfile,
  override?: Partial<EvolutionBudget>,
): EvolutionBudget {
  return { ...defaultEvolutionBudget(profile), ...override };
}

function resolveLearningScopeId(request: CreateEvolutionRunRequest): string;
function resolveLearningScopeId(projectId: string): string;
function resolveLearningScopeId(
  input: CreateEvolutionRunRequest | string,
): string {
  if (typeof input === "string") {
    const normalized = input.trim();
    if (!normalized) throw new Error("evolution_project_id_required");
    return normalized === EVOLUTION_GLOBAL_SCOPE_ID
      ? EVOLUTION_GLOBAL_SCOPE_ID
      : resolveTerminalParentProjectId(normalized);
  }
  if (input.scope && input.projectId !== undefined) {
    throw new Error("evolution_scope_conflict");
  }
  if (input.scope?.type === "global") {
    return EVOLUTION_GLOBAL_SCOPE_ID;
  }
  if (input.scope?.type === "project") {
    return resolveLearningScopeId(input.scope.projectId);
  }
  if (input.projectId !== undefined) {
    return resolveLearningScopeId(input.projectId);
  }
  throw new Error("evolution_scope_required");
}

function isTerminalStage(stage: EvolutionRunStage): boolean {
  return (
    stage === "completed" ||
    stage === "no_material_novelty" ||
    stage === "partial" ||
    stage === "failed" ||
    stage === "cancelled" ||
    stage === "blocked"
  );
}
