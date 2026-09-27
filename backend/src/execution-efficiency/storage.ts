import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  EfficiencyAnalysisDecision,
  EfficiencyAnalysisRun,
  EfficiencyCheckpoint,
  EfficiencyFinding,
  EfficiencyFindingDetail,
  EfficiencyFindingEvent,
  EfficiencyFindingFilter,
  EfficiencyFindingPage,
  EfficiencyObservation,
  EfficiencyTaskBinding,
  CollectEfficiencyResponse,
  SubmitEfficiencyResultResponse,
} from "@runweave/shared/execution-efficiency";
import { ExecutionEfficiencyError } from "./errors";
import {
  migrateExecutionEfficiencyStore,
  unavailableMeasurement,
} from "./storage-support";

interface IdempotencyRecord<T> {
  requestHash: string;
  response: T;
}

export class ExecutionEfficiencyStore {
  private readonly database: Database.Database;
  private closed = false;

  constructor(databaseFile: string) {
    mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.database = new Database(databaseFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    migrateExecutionEfficiencyStore(this.database);
  }

  transaction<T>(action: () => T): T {
    this.requireOpen();
    return this.database.transaction(action)();
  }

  getBinding(projectId: string): EfficiencyTaskBinding | null {
    const row = this.database
      .prepare("SELECT payload_json FROM efficiency_bindings WHERE project_id = ?")
      .get(projectId) as { payload_json: string } | undefined;
    return row ? parse<EfficiencyTaskBinding>(row.payload_json) : null;
  }

  putBinding(binding: EfficiencyTaskBinding, expectedRevision: number): void {
    this.transaction(() => {
      const current = this.getBinding(binding.projectId);
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new ExecutionEfficiencyError(
          "revision_conflict",
          409,
          "The task binding changed; refresh before saving",
        );
      this.database
        .prepare(
          `INSERT INTO efficiency_bindings(project_id, task_id, revision, payload_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET task_id = excluded.task_id,
             revision = excluded.revision, payload_json = excluded.payload_json`,
        )
        .run(
          binding.projectId,
          binding.taskId,
          binding.revision,
          JSON.stringify(binding),
        );
    });
  }

  listCheckpoints(repositoryId: string): Map<string, EfficiencyCheckpoint> {
    const rows = this.database
      .prepare(
        "SELECT session_id, payload_json FROM efficiency_checkpoints WHERE repository_id = ?",
      )
      .all(repositoryId) as Array<{ session_id: string; payload_json: string }>;
    return new Map(
      rows.map((row) => [row.session_id, parse<EfficiencyCheckpoint>(row.payload_json)]),
    );
  }

  listAnalysisThreadIds(projectId: string): Set<string> {
    const rows = this.database
      .prepare(
        "SELECT thread_id FROM efficiency_analysis_runs WHERE project_id = ? AND thread_id IS NOT NULL",
      )
      .all(projectId) as Array<{ thread_id: string }>;
    return new Set(rows.map((row) => row.thread_id));
  }

  latestAnalysis(projectId: string): EfficiencyAnalysisRun | null {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM efficiency_analysis_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId) as { payload_json: string } | undefined;
    return row ? parse<EfficiencyAnalysisRun>(row.payload_json) : null;
  }

  getAnalysis(analysisId: string): EfficiencyAnalysisRun | null {
    const row = this.database
      .prepare("SELECT payload_json FROM efficiency_analysis_runs WHERE id = ?")
      .get(analysisId) as { payload_json: string } | undefined;
    return row ? parse<EfficiencyAnalysisRun>(row.payload_json) : null;
  }

  findActiveAnalysis(projectId: string): EfficiencyAnalysisRun | null {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM efficiency_analysis_runs WHERE project_id = ? AND status = 'collected' ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId) as { payload_json: string } | undefined;
    return row ? parse<EfficiencyAnalysisRun>(row.payload_json) : null;
  }

  listPendingUsage(limit = 20): EfficiencyAnalysisRun[] {
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM efficiency_analysis_runs
         WHERE status = 'submitted' AND json_extract(payload_json, '$.analysisUsageCompleteness') = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Array<{ payload_json: string }>;
    return rows.map((row) => parse<EfficiencyAnalysisRun>(row.payload_json));
  }

  markAnalysisInterrupted(run: EfficiencyAnalysisRun): void {
    this.database
      .prepare(
        "UPDATE efficiency_analysis_runs SET status = 'interrupted', payload_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(run), run.id);
  }

  getCollectionByIdempotency(
    key: string,
    requestHash: string,
  ): CollectEfficiencyResponse | null {
    const existing = this.getIdempotency<CollectEfficiencyResponse>("collect", key);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw idempotencyConflict();
    return existing.response;
  }

  getSubmissionByIdempotency(
    analysisId: string,
    key: string,
    requestHash: string,
  ): SubmitEfficiencyResultResponse | null {
    const existing = this.getIdempotency<SubmitEfficiencyResultResponse>(
      `submit:${analysisId}`,
      key,
    );
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw idempotencyConflict();
    return existing.response;
  }

  saveCollection(input: {
    run: EfficiencyAnalysisRun;
    response: CollectEfficiencyResponse;
    observations: EfficiencyObservation[];
    checkpoints: EfficiencyCheckpoint[];
    idempotencyKey: string;
    requestHash: string;
  }): CollectEfficiencyResponse {
    return this.transaction(() => {
      const existing = this.getIdempotency<CollectEfficiencyResponse>(
        "collect",
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== input.requestHash)
          throw idempotencyConflict();
        return existing.response;
      }
      const observationStatement = this.database.prepare(
        `INSERT OR IGNORE INTO efficiency_observations
          (id, project_id, repository_id, dimension, observed_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const observation of input.observations) {
        observationStatement.run(
          observation.id,
          observation.projectId,
          observation.repositoryId,
          observation.dimension,
          observation.observedAt,
          JSON.stringify(observation),
        );
      }
      const checkpointStatement = this.database.prepare(
        `INSERT INTO efficiency_checkpoints(repository_id, session_id, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(repository_id, session_id) DO UPDATE SET payload_json = excluded.payload_json`,
      );
      for (const checkpoint of input.checkpoints) {
        checkpointStatement.run(
          checkpoint.repositoryId,
          checkpoint.sessionId,
          JSON.stringify(checkpoint),
        );
      }
      this.database
        .prepare(
          `INSERT INTO efficiency_analysis_runs
           (id, project_id, task_id, scheduled_run_id, thread_id, status, created_at, payload_json, candidates_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.run.id,
          input.run.projectId,
          input.run.taskId,
          input.run.scheduledRunId,
          input.run.threadId,
          input.run.status,
          input.run.createdAt,
          JSON.stringify(input.run),
          JSON.stringify(input.response.candidates),
        );
      this.putIdempotency(
        "collect",
        input.idempotencyKey,
        input.requestHash,
        input.response,
      );
      return input.response;
    });
  }

  readCollection(analysisId: string): CollectEfficiencyResponse | null {
    const row = this.database
      .prepare(
        "SELECT candidates_json, payload_json FROM efficiency_analysis_runs WHERE id = ?",
      )
      .get(analysisId) as
      | { candidates_json: string; payload_json: string }
      | undefined;
    if (!row) return null;
    const run = parse<EfficiencyAnalysisRun>(row.payload_json);
    return {
      analysisId: run.id,
      evidenceVersion: run.evidenceVersion,
      candidates: parse(row.candidates_json),
      questions: this.listPendingQuestions(run.projectId),
      coverage: run.coverage,
      hasMore: run.coverage.backlog,
    };
  }

  getObservations(ids: string[]): EfficiencyObservation[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM efficiency_observations WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ payload_json: string }>;
    return rows.map((row) => parse<EfficiencyObservation>(row.payload_json));
  }

  hasDecision(fingerprint: string, policyVersion: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM efficiency_decisions WHERE fingerprint = ? AND policy_version = ?",
        )
        .get(fingerprint, policyVersion),
    );
  }

  saveAnalysisResult(input: {
    run: EfficiencyAnalysisRun;
    findings: Array<{ finding: EfficiencyFinding; analysisId: string }>;
    appendedEvidence: Array<{ finding: EfficiencyFinding; observationIds: string[] }>;
    decisions: EfficiencyAnalysisDecision[];
    answers: EfficiencyFindingEvent[];
    response: SubmitEfficiencyResultResponse;
    idempotencyKey: string;
    requestHash: string;
  }): SubmitEfficiencyResultResponse {
    return this.transaction(() => {
      const existing = this.getIdempotency<SubmitEfficiencyResultResponse>(
        `submit:${input.run.id}`,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== input.requestHash)
          throw idempotencyConflict();
        return existing.response;
      }
      const insertFinding = this.database.prepare(
        `INSERT INTO efficiency_findings
         (id, project_id, dimension, status, revision, updated_at, analysis_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateFinding = this.database.prepare(
        `UPDATE efficiency_findings SET status = ?, revision = ?, updated_at = ?, payload_json = ? WHERE id = ?`,
      );
      const link = this.database.prepare(
        "INSERT OR IGNORE INTO efficiency_finding_observations(finding_id, observation_id) VALUES (?, ?)",
      );
      for (const item of input.findings) {
        insertFinding.run(
          item.finding.id,
          item.finding.projectId,
          item.finding.dimension,
          item.finding.status,
          item.finding.revision,
          item.finding.updatedAt,
          item.analysisId,
          JSON.stringify(item.finding),
        );
        item.finding.observationIds.forEach((id) => link.run(item.finding.id, id));
      }
      for (const item of input.appendedEvidence) {
        updateFinding.run(
          item.finding.status,
          item.finding.revision,
          item.finding.updatedAt,
          JSON.stringify(item.finding),
          item.finding.id,
        );
        item.observationIds.forEach((id) => link.run(item.finding.id, id));
      }
      const decisionStatement = this.database.prepare(
        `INSERT OR REPLACE INTO efficiency_decisions
         (fingerprint, policy_version, payload_json) VALUES (?, ?, ?)`,
      );
      for (const decision of input.decisions) {
        decisionStatement.run(
          decision.evidenceFingerprint,
          decision.policyVersion,
          JSON.stringify(decision),
        );
      }
      const answerStatement = this.database.prepare(
        `INSERT INTO efficiency_finding_events(id, finding_id, action, pending_question, created_at, payload_json)
         VALUES (?, ?, ?, 0, ?, ?)`,
      );
      for (const answer of input.answers) {
        answerStatement.run(
          answer.id,
          answer.findingId,
          answer.action,
          answer.createdAt,
          JSON.stringify(answer),
        );
        this.database
          .prepare(
            "UPDATE efficiency_finding_events SET pending_question = 0 WHERE finding_id = ? AND pending_question = 1",
          )
          .run(answer.findingId);
      }
      this.database
        .prepare(
          "UPDATE efficiency_analysis_runs SET status = ?, payload_json = ? WHERE id = ?",
        )
        .run(input.run.status, JSON.stringify(input.run), input.run.id);
      this.putIdempotency(
        `submit:${input.run.id}`,
        input.idempotencyKey,
        input.requestHash,
        input.response,
      );
      return input.response;
    });
  }

  listFindings(filter: EfficiencyFindingFilter): EfficiencyFindingPage {
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    const values: unknown[] = [filter.projectId];
    const conditions = ["project_id = ?"];
    if (filter.dimension) {
      conditions.push("dimension = ?");
      values.push(filter.dimension);
    }
    if (filter.status) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter.q?.trim()) {
      conditions.push("payload_json LIKE ?");
      values.push(`%${filter.q.trim()}%`);
    }
    if (filter.cursor) {
      conditions.push("updated_at < ?");
      values.push(filter.cursor);
    }
    values.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM efficiency_findings WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...values) as Array<{ payload_json: string }>;
    const findings = rows.map((row) => parse<EfficiencyFinding>(row.payload_json));
    const page = findings.slice(0, limit);
    return {
      items: page.map((finding) => ({
        ...finding,
        measurement:
          this.latestObservation(finding.observationIds)?.measurement ??
          unavailableMeasurement(finding.dimension),
      })),
      nextCursor: findings.length > limit ? page.at(-1)?.updatedAt ?? null : null,
    };
  }

  getFinding(findingId: string): EfficiencyFindingDetail | null {
    const row = this.database
      .prepare("SELECT payload_json, analysis_id FROM efficiency_findings WHERE id = ?")
      .get(findingId) as
      | { payload_json: string; analysis_id: string | null }
      | undefined;
    if (!row) return null;
    const finding = parse<EfficiencyFinding>(row.payload_json);
    const observations = this.getObservations(finding.observationIds);
    const events = (
      this.database
        .prepare(
          "SELECT payload_json FROM efficiency_finding_events WHERE finding_id = ? ORDER BY created_at ASC",
        )
        .all(findingId) as Array<{ payload_json: string }>
    ).map((item) => parse<EfficiencyFindingEvent>(item.payload_json));
    const analysis = row.analysis_id ? this.getAnalysis(row.analysis_id) : null;
    return {
      ...finding,
      observations,
      events,
      source: {
        taskId: analysis?.taskId ?? null,
        scheduledRunId: analysis?.scheduledRunId ?? null,
        analysisId: analysis?.id ?? null,
      },
    };
  }

  putFindingEvent(input: {
    finding: EfficiencyFinding;
    event: EfficiencyFindingEvent;
    expectedRevision: number;
    idempotencyKey: string;
    requestHash: string;
    pendingQuestion: boolean;
  }): EfficiencyFindingDetail {
    return this.transaction(() => {
      const existing = this.getIdempotency<EfficiencyFindingDetail>(
        `finding-event:${input.finding.id}`,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== input.requestHash)
          throw idempotencyConflict();
        return existing.response;
      }
      const current = this.getFinding(input.finding.id);
      if (!current)
        throw new ExecutionEfficiencyError("finding_not_found", 404, "Finding not found");
      if (current.revision !== input.expectedRevision)
        throw new ExecutionEfficiencyError(
          "revision_conflict",
          409,
          "The finding changed; refresh before saving",
        );
      this.database
        .prepare(
          `UPDATE efficiency_findings SET status = ?, revision = ?, updated_at = ?, payload_json = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          input.finding.status,
          input.finding.revision,
          input.finding.updatedAt,
          JSON.stringify(input.finding),
          input.finding.id,
          input.expectedRevision,
        );
      this.database
        .prepare(
          `INSERT INTO efficiency_finding_events(id, finding_id, action, pending_question, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.event.id,
          input.event.findingId,
          input.event.action,
          input.pendingQuestion ? 1 : 0,
          input.event.createdAt,
          JSON.stringify(input.event),
        );
      const link = this.database.prepare(
        "INSERT OR IGNORE INTO efficiency_finding_observations(finding_id, observation_id) VALUES (?, ?)",
      );
      for (const observationId of input.event.observationIds) {
        link.run(input.finding.id, observationId);
      }
      const detail = this.getFinding(input.finding.id)!;
      this.putIdempotency(
        `finding-event:${input.finding.id}`,
        input.idempotencyKey,
        input.requestHash,
        detail,
      );
      return detail;
    });
  }

  listPendingQuestions(projectId: string): Array<{ findingId: string; question: string }> {
    const rows = this.database
      .prepare(
        `SELECT e.finding_id, e.payload_json FROM efficiency_finding_events e
         JOIN efficiency_findings f ON f.id = e.finding_id
         WHERE f.project_id = ? AND e.pending_question = 1
         ORDER BY e.created_at ASC`,
      )
      .all(projectId) as Array<{ finding_id: string; payload_json: string }>;
    return rows.map((row) => ({
      findingId: row.finding_id,
      question: parse<EfficiencyFindingEvent>(row.payload_json).note,
    }));
  }

  updateAnalysisUsage(run: EfficiencyAnalysisRun): void {
    this.database
      .prepare(
        "UPDATE efficiency_analysis_runs SET thread_id = ?, status = ?, payload_json = ? WHERE id = ?",
      )
      .run(run.threadId, run.status, JSON.stringify(run), run.id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private latestObservation(ids: string[]): EfficiencyObservation | null {
    const observations = this.getObservations(ids);
    return observations.sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0] ?? null;
  }

  private getIdempotency<T>(scope: string, key: string): IdempotencyRecord<T> | null {
    const row = this.database
      .prepare(
        "SELECT request_hash, response_json FROM efficiency_idempotency WHERE scope = ? AND key = ?",
      )
      .get(scope, key) as
      | { request_hash: string; response_json: string }
      | undefined;
    return row
      ? { requestHash: row.request_hash, response: parse<T>(row.response_json) }
      : null;
  }

  private putIdempotency(
    scope: string,
    key: string,
    requestHash: string,
    response: unknown,
  ): void {
    this.database
      .prepare(
        `INSERT INTO efficiency_idempotency(scope, key, request_hash, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(scope, key, requestHash, JSON.stringify(response), new Date().toISOString());
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("efficiency_store_closed");
  }
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function idempotencyConflict(): ExecutionEfficiencyError {
  return new ExecutionEfficiencyError(
    "idempotency_conflict",
    409,
    "Idempotency key was reused with different input",
  );
}
