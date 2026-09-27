import { createHash, randomUUID } from "node:crypto";
import type {
  CollectEfficiencyRequest,
  CollectEfficiencyResponse,
  CreateEfficiencyFindingEventRequest,
  EfficiencyAnalysisDecision,
  EfficiencyAnalysisRun,
  EfficiencyCandidate,
  EfficiencyFinding,
  EfficiencyFindingDetail,
  EfficiencyFindingEvent,
  EfficiencyFindingFilter,
  EfficiencyFindingPage,
  ExecutionEfficiencyStatus,
  PutEfficiencyBindingRequest,
  SubmitEfficiencyResultRequest,
  SubmitEfficiencyResultResponse,
} from "@runweave/shared/execution-efficiency";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { recoverAnalysisUsage } from "./analysis-usage";
import {
  collectProjectEvidence,
  resolveCodexLogRoots,
  type CollectedEfficiencyObservation,
} from "./collector/reader";
import {
  EXECUTION_EFFICIENCY_POLICY_VERSION,
  screenMeasurement,
} from "./collector/screening";
import { ExecutionEfficiencyError } from "./errors";
import { resolveEfficiencyProjectScope } from "./identity";
import { EfficiencyScheduledSource } from "./scheduled-source";
import { ExecutionEfficiencyStore } from "./storage";
import { validateDecision } from "./validation";

const MAX_MODEL_ITEMS = 3;
const MAX_EVIDENCE_CHARS = 24_000;

export class ExecutionEfficiencyService {
  private readonly scheduledSource: EfficiencyScheduledSource;
  private readonly logRoots: string[];

  constructor(
    private readonly store: ExecutionEfficiencyStore | null,
    private readonly terminalSessionManager: TerminalSessionManager,
    scheduledSource: EfficiencyScheduledSource,
    private readonly unavailableReason: string | null = null,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.scheduledSource = scheduledSource;
    this.logRoots = resolveCodexLogRoots(env);
  }

  async status(projectId: string): Promise<ExecutionEfficiencyStatus> {
    resolveEfficiencyProjectScope(this.terminalSessionManager, projectId);
    if (!this.store) {
      return {
        available: false,
        reason: this.unavailableReason ?? "Execution efficiency storage is unavailable",
        projectId,
        binding: null,
        latestAnalysis: null,
        pendingQuestions: 0,
      };
    }
    await this.recoverPendingAnalysisUsage();
    return {
      available: true,
      projectId,
      binding: this.store.getBinding(projectId),
      latestAnalysis: this.store.latestAnalysis(projectId),
      pendingQuestions: this.store.listPendingQuestions(projectId).length,
    };
  }

  async bind(input: PutEfficiencyBindingRequest) {
    this.requireStore();
    resolveEfficiencyProjectScope(this.terminalSessionManager, input.projectId);
    await this.scheduledSource.validateBinding(input.projectId, input.taskId);
    const current = this.store!.getBinding(input.projectId);
    const now = new Date().toISOString();
    const binding = {
      projectId: input.projectId,
      taskId: input.taskId,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.store!.putBinding(binding, input.expectedRevision);
    return binding;
  }

  async collect(
    input: CollectEfficiencyRequest,
    idempotencyKey: string,
  ): Promise<CollectEfficiencyResponse> {
    const store = this.requireStore();
    const requestHash = hash(input);
    const replay = store.getCollectionByIdempotency(idempotencyKey, requestHash);
    if (replay) return replay;
    const binding = store.getBinding(input.projectId);
    if (!binding)
      throw new ExecutionEfficiencyError(
        "binding_not_found",
        409,
        "No scheduled task is bound to this project",
      );
    await this.scheduledSource.validateBinding(input.projectId, binding.taskId);
    const scheduledRun = await this.scheduledSource.requireActiveRun(
      binding,
      input.scheduledRunId,
    );
    let interruptedCandidates: EfficiencyCandidate[] = [];
    const active = store.findActiveAnalysis(input.projectId);
    if (active) {
      if (active.scheduledRunId === input.scheduledRunId) {
        const existing = store.readCollection(active.id);
        if (existing) return existing;
      }
      const ownerRun = await this.scheduledSource.getRun(active.scheduledRunId).catch(() => null);
      if (ownerRun && new Set(["running", "stopping"]).has(ownerRun.status)) {
        throw new ExecutionEfficiencyError(
          "analysis_busy",
          409,
          "Another analysis run owns this repository",
          { scheduledRunId: active.scheduledRunId },
        );
      }
      interruptedCandidates =
        store
          .readCollection(active.id)
          ?.candidates.filter(
            (candidate) =>
              !store.hasDecision(candidate.fingerprint, active.policyVersion),
          ) ?? [];
      store.markAnalysisInterrupted({ ...active, status: "interrupted" });
    }
    const scope = resolveEfficiencyProjectScope(
      this.terminalSessionManager,
      input.projectId,
    );
    const collection = await collectProjectEvidence({
      projectId: input.projectId,
      repositoryId: scope.repositoryId,
      projectPaths: scope.paths,
      logRoots: this.logRoots,
      checkpoints: store.listCheckpoints(scope.repositoryId),
      excludedThreadIds: store.listAnalysisThreadIds(input.projectId),
    });
    const questions = store.listPendingQuestions(input.projectId);
    const candidateLimit = Math.max(0, MAX_MODEL_ITEMS - questions.length);
    const pendingFreshObservations = collection.observations.filter(
      (item) =>
        item.admitted &&
        !store.hasDecision(
          fingerprint([item.observation.id]),
          EXECUTION_EFFICIENCY_POLICY_VERSION,
        ),
    );
    const freshCandidates = chooseCandidates(
      pendingFreshObservations,
      candidateLimit,
    );
    const seen = new Set<string>();
    const candidates = [...interruptedCandidates, ...freshCandidates]
      .filter((candidate) => {
        if (seen.has(candidate.fingerprint)) return false;
        seen.add(candidate.fingerprint);
        return true;
      })
      .slice(0, candidateLimit);
    const includedObservationIds = new Set(
      candidates.flatMap((candidate) => candidate.observationIds),
    );
    const deferredSessionIds = new Set(
      pendingFreshObservations
        .filter((item) => !includedObservationIds.has(item.observation.id))
        .map((item) => item.observation.threadId),
    );
    const hasMore =
      collection.coverage.backlog ||
      interruptedCandidates.length + freshCandidates.length > candidateLimit ||
      deferredSessionIds.size > 0;
    const coverage = hasMore
      ? { ...collection.coverage, backlog: true }
      : collection.coverage;
    const now = new Date().toISOString();
    const latest = store.latestAnalysis(input.projectId);
    const run: EfficiencyAnalysisRun = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: binding.taskId,
      scheduledRunId: input.scheduledRunId,
      threadId: scheduledRun.threadRef?.threadId ?? null,
      policyVersion: EXECUTION_EFFICIENCY_POLICY_VERSION,
      evidenceVersion: (latest?.evidenceVersion ?? 0) + 1,
      status: "collected",
      coverage,
      resultCount: 0,
      analysisUsage: null,
      analysisUsageCompleteness: "pending",
      createdAt: now,
      submittedAt: null,
    };
    const response: CollectEfficiencyResponse = {
      analysisId: run.id,
      evidenceVersion: run.evidenceVersion,
      candidates,
      questions: questions.slice(0, MAX_MODEL_ITEMS),
      coverage,
      hasMore,
    };
    return store.saveCollection({
      run,
      response,
      observations: collection.observations.map((item) => item.observation),
      checkpoints: collection.checkpoints.filter(
        (checkpoint) => !deferredSessionIds.has(checkpoint.sessionId),
      ),
      idempotencyKey,
      requestHash,
    });
  }

  async submit(
    analysisId: string,
    input: SubmitEfficiencyResultRequest,
    idempotencyKey: string,
  ): Promise<SubmitEfficiencyResultResponse> {
    const store = this.requireStore();
    const requestHash = hash(input);
    const replay = store.getSubmissionByIdempotency(
      analysisId,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;
    const run = store.getAnalysis(analysisId);
    if (!run)
      throw new ExecutionEfficiencyError("analysis_not_found", 404, "Analysis not found");
    if (run.status !== "collected" || run.evidenceVersion !== input.evidenceVersion) {
      throw new ExecutionEfficiencyError(
        "analysis_conflict",
        409,
        "Analysis evidence is stale or already submitted",
      );
    }
    const binding = store.getBinding(run.projectId);
    if (!binding || binding.taskId !== run.taskId)
      throw new ExecutionEfficiencyError(
        "run_owner_conflict",
        409,
        "The analysis task binding changed",
      );
    await this.scheduledSource.requireActiveRun(binding, run.scheduledRunId);
    const collection = store.readCollection(analysisId);
    if (!collection)
      throw new ExecutionEfficiencyError("analysis_not_found", 404, "Analysis not found");
    const allowed = new Map(collection.candidates.map((item) => [item.fingerprint, item]));
    const findings: Array<{ finding: EfficiencyFinding; analysisId: string }> = [];
    const appendedEvidence: Array<{
      finding: EfficiencyFinding;
      observationIds: string[];
    }> = [];
    const decisions: EfficiencyAnalysisDecision[] = [];
    const findingIds: string[] = [];
    const now = new Date().toISOString();
    for (const decision of input.decisions) {
      const candidate = allowed.get(decision.fingerprint);
      if (!candidate || !sameMembers(candidate.observationIds, decision.observationIds))
        throw new ExecutionEfficiencyError(
          "invalid_evidence",
          400,
          "Decision references evidence outside this analysis",
        );
      const observations = store.getObservations(decision.observationIds);
      validateDecision(decision, observations, run.projectId);
      const recalculated = observations.map((observation) =>
        screenMeasurement(observation.dimension, observation.measurement),
      );
      if (decision.verdict === "admit" && !recalculated.some((item) => item.admitted))
        throw new ExecutionEfficiencyError(
          "admission_rejected",
          400,
          "Referenced observations do not meet the active measurement policy",
        );
      let findingId: string | null = null;
      if (decision.verdict === "admit") {
        if (decision.findingId) {
          const current = store.getFinding(decision.findingId);
          if (
            !current ||
            current.projectId !== run.projectId ||
            current.dimension !== candidate.dimension
          ) {
            throw new ExecutionEfficiencyError(
              "finding_not_found",
              404,
              "Existing finding does not match this project and dimension",
            );
          }
          const newObservationIds = decision.observationIds.filter(
            (id) => !current.observationIds.includes(id),
          );
          const next: EfficiencyFinding = {
            ...current,
            observationIds: [...current.observationIds, ...newObservationIds],
            revision: current.revision + 1,
            hasNewEvidence: newObservationIds.length > 0 || current.hasNewEvidence,
            updatedAt: now,
          };
          appendedEvidence.push({ finding: next, observationIds: newObservationIds });
          findingId = next.id;
        } else {
          const programReason = recalculated.find((item) => item.admitted)!.reason;
          const finding: EfficiencyFinding = {
            id: randomUUID(),
            projectId: run.projectId,
            dimension: candidate.dimension,
            observationIds: decision.observationIds,
            title: decision.title.trim(),
            admissionReason: `${programReason}；${decision.admissionReason.trim()}`,
            hypothesis: decision.hypothesis.trim(),
            causeTags: decision.causeTags.slice(0, 8),
            uncertainty: decision.uncertainty.trim(),
            verification: decision.verification.trim(),
            status: "pending",
            revision: 1,
            hasNewEvidence: false,
            createdAt: now,
            updatedAt: now,
          };
          findings.push({ finding, analysisId });
          findingId = finding.id;
        }
        findingIds.push(findingId);
      }
      decisions.push({
        evidenceFingerprint: decision.fingerprint,
        policyVersion: run.policyVersion,
        verdict: decision.verdict,
        findingId,
        reason: decision.admissionReason.trim(),
        decidedAt: now,
      });
    }
    const answers: EfficiencyFindingEvent[] = [];
    const pendingQuestions = new Set(
      store.listPendingQuestions(run.projectId).map((item) => item.findingId),
    );
    for (const answer of input.answers ?? []) {
      if (!pendingQuestions.has(answer.findingId) || !answer.note.trim()) {
        throw new ExecutionEfficiencyError(
          "invalid_question_answer",
          400,
          "Answer must reference a pending question in this project",
        );
      }
      answers.push({
        id: randomUUID(),
        findingId: answer.findingId,
        action: "add-note",
        note: answer.note.trim(),
        verification: null,
        observationIds: answer.observationIds ?? [],
        createdAt: now,
      });
    }
    const submitted: EfficiencyAnalysisRun = {
      ...run,
      status: "submitted",
      resultCount: findings.length + appendedEvidence.length,
      submittedAt: now,
    };
    const response: SubmitEfficiencyResultResponse = {
      analysisId,
      accepted: findings.length + appendedEvidence.length,
      dismissed: decisions.filter((item) => item.verdict === "dismiss").length,
      findingIds,
    };
    return store.saveAnalysisResult({
      run: submitted,
      findings,
      appendedEvidence,
      decisions,
      answers,
      response,
      idempotencyKey,
      requestHash,
    });
  }

  listFindings(filter: EfficiencyFindingFilter): EfficiencyFindingPage {
    this.requireProject(filter.projectId);
    return this.requireStore().listFindings(filter);
  }

  getFinding(findingId: string): EfficiencyFindingDetail {
    const finding = this.requireStore().getFinding(findingId);
    if (!finding)
      throw new ExecutionEfficiencyError("finding_not_found", 404, "Finding not found");
    return finding;
  }

  addFindingEvent(
    findingId: string,
    input: CreateEfficiencyFindingEventRequest,
    idempotencyKey: string,
  ): EfficiencyFindingDetail {
    const store = this.requireStore();
    const current = store.getFinding(findingId);
    if (!current)
      throw new ExecutionEfficiencyError("finding_not_found", 404, "Finding not found");
    const note = input.note.trim();
    if (!note)
      throw new ExecutionEfficiencyError("invalid_input", 400, "A note is required");
    if (
      input.action === "resolve" &&
      (!input.confirmed || !input.verification?.trim())
    ) {
      throw new ExecutionEfficiencyError(
        "confirmation_required",
        400,
        "Resolving requires a result, verification record, and explicit confirmation",
      );
    }
    const observations = input.observationIds?.length
      ? store.getObservations(input.observationIds)
      : [];
    if (
      observations.length !== (input.observationIds?.length ?? 0) ||
      observations.some(
        (item) =>
          item.projectId !== current.projectId || item.dimension !== current.dimension,
      )
    ) {
      throw new ExecutionEfficiencyError(
        "invalid_evidence",
        400,
        "Event evidence must match the finding project and dimension",
      );
    }
    const now = new Date().toISOString();
    const next: EfficiencyFinding = {
      ...current,
      status: nextStatus(current.status, input.action),
      revision: current.revision + 1,
      observationIds: [
        ...new Set([...current.observationIds, ...(input.observationIds ?? [])]),
      ],
      hasNewEvidence:
        input.action === "add-evidence" ? true : current.hasNewEvidence,
      updatedAt: now,
    };
    const event: EfficiencyFindingEvent = {
      id: randomUUID(),
      findingId,
      action: input.action,
      note,
      verification: input.verification?.trim() || null,
      observationIds: input.observationIds ?? [],
      createdAt: now,
    };
    return store.putFindingEvent({
      finding: next,
      event,
      expectedRevision: input.expectedRevision,
      idempotencyKey,
      requestHash: hash(input),
      pendingQuestion: input.action === "ask-analysis",
    });
  }

  private requireProject(projectId: string): void {
    resolveEfficiencyProjectScope(this.terminalSessionManager, projectId);
  }

  private requireStore(): ExecutionEfficiencyStore {
    if (!this.store)
      throw new ExecutionEfficiencyError(
        "storage_unavailable",
        503,
        this.unavailableReason ?? "Execution efficiency storage is unavailable",
      );
    return this.store;
  }

  private async recoverPendingAnalysisUsage(): Promise<void> {
    if (!this.store) return;
    for (const analysis of this.store.listPendingUsage(20)) {
      const run = await this.scheduledSource.getRun(analysis.scheduledRunId).catch(() => null);
      if (!run) {
        this.store.updateAnalysisUsage({
          ...analysis,
          analysisUsageCompleteness: "unavailable",
        });
        continue;
      }
      const recovered = await recoverAnalysisUsage(analysis, run, this.logRoots);
      if (recovered !== analysis) this.store.updateAnalysisUsage(recovered);
    }
  }
}

function chooseCandidates(
  items: CollectedEfficiencyObservation[],
  limit: number,
): EfficiencyCandidate[] {
  const queues = {
    duration: items.filter((item) => item.observation.dimension === "duration"),
    tokens: items.filter((item) => item.observation.dimension === "tokens"),
  };
  const selected: CollectedEfficiencyObservation[] = [];
  let dimension: keyof typeof queues = "duration";
  while (selected.length < limit && (queues.duration.length || queues.tokens.length)) {
    const item = queues[dimension].shift() ?? queues[dimension === "duration" ? "tokens" : "duration"].shift();
    if (item) selected.push(item);
    dimension = dimension === "duration" ? "tokens" : "duration";
  }
  let chars = 0;
  return selected.flatMap((item) => {
    const excerpt = item.observation.sourceSpan.excerpt.slice(
      0,
      Math.min(1_800, Math.max(0, MAX_EVIDENCE_CHARS - chars)),
    );
    if (!excerpt) return [];
    chars += excerpt.length;
    const observationIds = [item.observation.id];
    return [
      {
        fingerprint: fingerprint(observationIds),
        dimension: item.observation.dimension,
        observationIds,
        title: item.title,
        evidence: [
          {
            observationId: item.observation.id,
            excerpt,
            measurement: item.observation.measurement,
          },
        ],
        question: null,
      },
    ];
  });
}

function nextStatus(
  current: EfficiencyFinding["status"],
  action: CreateEfficiencyFindingEventRequest["action"],
): EfficiencyFinding["status"] {
  switch (action) {
    case "start-processing":
      return "processing";
    case "resolve":
      return "resolved";
    case "defer":
      return "deferred";
    case "dismiss":
      return "dismissed";
    case "reopen":
      return "pending";
    default:
      return current;
  }
}

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function fingerprint(observationIds: string[]): string {
  return hash({ observationIds: [...observationIds].sort(), policy: EXECUTION_EFFICIENCY_POLICY_VERSION });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
