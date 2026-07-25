import type Database from "better-sqlite3";
import type {
  EvolutionRun,
  EvolutionRunOutcome,
  EvolutionSchedule,
  EvolutionWatermark,
} from "@runweave/shared/evolution";
import type {
  EvolutionDueScheduleMaterialization,
  EvolutionRunClaim,
  EvolutionRunListQuery,
  EvolutionRunTransition,
} from "../foundation-store";
import {
  assertScheduleMaterialization,
  EVOLUTION_ACTIVE_STAGES,
  EVOLUTION_TERMINAL_STAGES,
  evolutionTriggerPriority,
  isAllowedEvolutionRunTransition,
  parseEvolutionTimestamp,
} from "./foundation-rules";
import {
  type EvolutionLeaseRow,
  type EvolutionRunRow,
  nullableTimestamp,
  placeholders,
  toIso,
  toRun,
} from "./foundation-database-rows";

const GLOBAL_LEASE_KEY = "global-evolution-runner-v1";

export class EvolutionFoundationDatabase {
  constructor(private readonly database: Database.Database) {}

  createRun(run: EvolutionRun): void {
    this.database
      .prepare(
        `INSERT INTO evolution_runs (
          run_id, learning_scope_id, trigger_type, priority, trigger_json,
          profile, provider_policy, budget_json, data_range_json, stage,
          outcome, created_at_ms, updated_at_ms, started_at_ms,
          completed_at_ms, attempt, owner_id, fencing_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        run.runId,
        run.learningScopeId,
        run.trigger.type,
        evolutionTriggerPriority(run.trigger.type),
        JSON.stringify(run.trigger),
        run.profile,
        run.providerPolicy,
        JSON.stringify(run.budget),
        JSON.stringify(run.dataRange),
        run.stage,
        run.outcome,
        parseEvolutionTimestamp(run.createdAt),
        parseEvolutionTimestamp(run.updatedAt),
        nullableTimestamp(run.startedAt),
        nullableTimestamp(run.completedAt),
        run.attempt,
      );
  }

  getRun(runId: string): EvolutionRun | null {
    const row = this.database
      .prepare("SELECT * FROM evolution_runs WHERE run_id = ?")
      .get(runId) as EvolutionRunRow | undefined;
    return row ? toRun(row) : null;
  }

  listRuns(query: EvolutionRunListQuery = {}): EvolutionRun[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (query.learningScopeId) {
      conditions.push("learning_scope_id = ?");
      params.push(query.learningScopeId);
    }
    if (query.stage) {
      conditions.push("stage = ?");
      params.push(query.stage);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
    const rows = this.database
      .prepare(
        `SELECT * FROM evolution_runs ${where}
         ORDER BY created_at_ms DESC, run_id DESC LIMIT ?`,
      )
      .all(...params, limit) as EvolutionRunRow[];
    return rows.map(toRun);
  }

  claimNextRun(params: {
    ownerId: string;
    now: string;
    leaseTtlMs: number;
  }): EvolutionRunClaim | null {
    const nowMs = parseEvolutionTimestamp(params.now);
    return this.database
      .transaction(() => {
        this.recoverExpiredRunsAt(nowMs);
        const active = this.database
          .prepare(
            `SELECT 1 FROM evolution_runs
             WHERE stage IN (${placeholders(EVOLUTION_ACTIVE_STAGES.length)})
             LIMIT 1`,
          )
          .get(...EVOLUTION_ACTIVE_STAGES);
        if (active) return null;

        const lease = this.getLease();
        if (lease && lease.expires_at_ms > nowMs) return null;

        const row = this.database
          .prepare(
            `SELECT * FROM evolution_runs
             WHERE stage = 'queued'
             ORDER BY priority, created_at_ms, run_id
             LIMIT 1`,
          )
          .get() as EvolutionRunRow | undefined;
        if (!row) return null;

        const fencingToken = (lease?.fencing_token ?? 0) + 1;
        const expiresAtMs = nowMs + params.leaseTtlMs;
        this.database
          .prepare(
            `INSERT INTO evolution_leases (
              lease_key, owner_id, fencing_token, acquired_at_ms, expires_at_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(lease_key) DO UPDATE SET
              owner_id = excluded.owner_id,
              fencing_token = excluded.fencing_token,
              acquired_at_ms = excluded.acquired_at_ms,
              expires_at_ms = excluded.expires_at_ms`,
          )
          .run(
            GLOBAL_LEASE_KEY,
            params.ownerId,
            fencingToken,
            nowMs,
            expiresAtMs,
          );
        const result = this.database
          .prepare(
            `UPDATE evolution_runs
             SET stage = 'snapshotting', updated_at_ms = ?,
                 started_at_ms = COALESCE(started_at_ms, ?),
                 attempt = attempt + 1, owner_id = ?, fencing_token = ?
             WHERE run_id = ? AND stage = 'queued'`,
          )
          .run(nowMs, nowMs, params.ownerId, fencingToken, row.run_id);
        if (result.changes !== 1)
          throw new Error("evolution_run_claim_conflict");
        return {
          run: this.requireRun(row.run_id),
          ownerId: params.ownerId,
          fencingToken,
          leaseExpiresAt: toIso(expiresAtMs),
        };
      })
      .immediate();
  }

  heartbeatRunClaim(params: {
    ownerId: string;
    fencingToken: number;
    now: string;
    leaseTtlMs: number;
  }): string {
    const nowMs = parseEvolutionTimestamp(params.now);
    const expiresAtMs = nowMs + params.leaseTtlMs;
    const result = this.database
      .prepare(
        `UPDATE evolution_leases SET expires_at_ms = ?
         WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
           AND expires_at_ms > ?`,
      )
      .run(
        expiresAtMs,
        GLOBAL_LEASE_KEY,
        params.ownerId,
        params.fencingToken,
        nowMs,
      );
    if (result.changes !== 1) throw new Error("evolution_lease_lost");
    return toIso(expiresAtMs);
  }

  transitionRun(transition: EvolutionRunTransition): EvolutionRun {
    if (
      !isAllowedEvolutionRunTransition(
        transition.expectedStage,
        transition.nextStage,
      )
    ) {
      throw new Error("evolution_run_transition_invalid");
    }
    const nowMs = parseEvolutionTimestamp(transition.now);
    return this.database
      .transaction(() => {
        this.assertLease(transition.ownerId, transition.fencingToken, nowMs);
        const current = this.requireRunRow(transition.runId);
        if (
          current.stage !== transition.expectedStage ||
          current.owner_id !== transition.ownerId ||
          current.fencing_token !== transition.fencingToken
        ) {
          throw new Error("evolution_run_transition_conflict");
        }
        const terminal = EVOLUTION_TERMINAL_STAGES.includes(
          transition.nextStage,
        );
        const outcome = terminal
          ? (transition.outcome ??
            (transition.nextStage as EvolutionRunOutcome))
          : null;
        this.database
          .prepare(
            `UPDATE evolution_runs
             SET stage = ?, outcome = ?, updated_at_ms = ?,
                 completed_at_ms = ?, owner_id = ?, fencing_token = ?
             WHERE run_id = ?`,
          )
          .run(
            transition.nextStage,
            outcome,
            nowMs,
            terminal ? nowMs : null,
            terminal ? null : transition.ownerId,
            terminal ? null : transition.fencingToken,
            transition.runId,
          );
        if (terminal)
          this.expireLease(transition.ownerId, transition.fencingToken, nowMs);
        return this.requireRun(transition.runId);
      })
      .immediate();
  }

  cancelRun(runId: string, now: string): EvolutionRun {
    const nowMs = parseEvolutionTimestamp(now);
    return this.database
      .transaction(() => {
        const current = this.requireRunRow(runId);
        if (EVOLUTION_TERMINAL_STAGES.includes(current.stage)) {
          return toRun(current);
        }
        this.database
          .prepare(
            `UPDATE evolution_runs
             SET stage = 'cancelled', outcome = 'cancelled',
                 updated_at_ms = ?, completed_at_ms = ?,
                 owner_id = NULL, fencing_token = NULL
             WHERE run_id = ?`,
          )
          .run(nowMs, nowMs, runId);
        if (current.owner_id && current.fencing_token) {
          this.expireLease(current.owner_id, current.fencing_token, nowMs);
        }
        return this.requireRun(runId);
      })
      .immediate();
  }

  recoverExpiredRuns(now: string): number {
    return this.database
      .transaction(() =>
        this.recoverExpiredRunsAt(parseEvolutionTimestamp(now)),
      )
      .immediate();
  }

  putSchedule(schedule: EvolutionSchedule): void {
    this.database
      .prepare(
        `INSERT INTO evolution_schedules (
          schedule_id, learning_scope_id, enabled, updated_at_ms, payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(schedule_id) DO UPDATE SET
          learning_scope_id = excluded.learning_scope_id,
          enabled = excluded.enabled,
          updated_at_ms = excluded.updated_at_ms,
          payload_json = excluded.payload_json
        WHERE excluded.updated_at_ms >= evolution_schedules.updated_at_ms`,
      )
      .run(
        schedule.scheduleId,
        schedule.learningScopeId,
        schedule.enabled ? 1 : 0,
        parseEvolutionTimestamp(schedule.updatedAt),
        JSON.stringify(schedule),
      );
  }

  getSchedule(scheduleId: string): EvolutionSchedule | null {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM evolution_schedules WHERE schedule_id = ?",
      )
      .get(scheduleId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as EvolutionSchedule) : null;
  }

  listSchedules(learningScopeId?: string): EvolutionSchedule[] {
    const rows = learningScopeId
      ? (this.database
          .prepare(
            `SELECT payload_json FROM evolution_schedules
             WHERE learning_scope_id = ? ORDER BY updated_at_ms DESC`,
          )
          .all(learningScopeId) as Array<{ payload_json: string }>)
      : (this.database
          .prepare(
            "SELECT payload_json FROM evolution_schedules ORDER BY updated_at_ms DESC",
          )
          .all() as Array<{ payload_json: string }>);
    return rows.map((row) => JSON.parse(row.payload_json) as EvolutionSchedule);
  }

  materializeDueSchedule(params: EvolutionDueScheduleMaterialization): boolean {
    const nowMs = parseEvolutionTimestamp(params.now);
    return this.database
      .transaction(() => {
        const row = this.database
          .prepare(
            "SELECT payload_json FROM evolution_schedules WHERE schedule_id = ?",
          )
          .get(params.scheduleId) as { payload_json: string } | undefined;
        if (!row) return false;
        const current = JSON.parse(row.payload_json) as EvolutionSchedule;
        if (
          !current.enabled ||
          current.nextDueAt !== params.expectedNextDueAt ||
          parseEvolutionTimestamp(params.expectedNextDueAt) > nowMs
        ) {
          return false;
        }
        assertScheduleMaterialization(current, params);
        this.createRun(params.run);
        this.database
          .prepare(
            `UPDATE evolution_schedules
             SET learning_scope_id = ?, enabled = ?,
                 updated_at_ms = ?, payload_json = ?
             WHERE schedule_id = ?`,
          )
          .run(
            params.nextSchedule.learningScopeId,
            params.nextSchedule.enabled ? 1 : 0,
            parseEvolutionTimestamp(params.nextSchedule.updatedAt),
            JSON.stringify(params.nextSchedule),
            params.scheduleId,
          );
        return true;
      })
      .immediate();
  }

  deleteSchedule(scheduleId: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM evolution_schedules WHERE schedule_id = ?")
        .run(scheduleId).changes === 1
    );
  }

  getWatermark(
    learningScopeId: string,
    source: string,
  ): EvolutionWatermark | null {
    const row = this.database
      .prepare(
        `SELECT value, run_id, updated_at_ms FROM evolution_watermarks
         WHERE learning_scope_id = ? AND source = ?`,
      )
      .get(learningScopeId, source) as
      | { value: string; run_id: string; updated_at_ms: number }
      | undefined;
    return row
      ? {
          learningScopeId,
          source,
          value: row.value,
          runId: row.run_id,
          updatedAt: toIso(row.updated_at_ms),
        }
      : null;
  }

  putWatermark(params: {
    watermark: EvolutionWatermark;
    ownerId: string;
    fencingToken: number;
    now: string;
  }): void {
    const nowMs = parseEvolutionTimestamp(params.now);
    this.database
      .transaction(() => {
        this.assertLease(params.ownerId, params.fencingToken, nowMs);
        const run = this.requireRunRow(params.watermark.runId);
        if (
          run.stage !== "validating" ||
          run.owner_id !== params.ownerId ||
          run.fencing_token !== params.fencingToken ||
          run.learning_scope_id !== params.watermark.learningScopeId
        ) {
          throw new Error("evolution_watermark_fence_mismatch");
        }
        this.database
          .prepare(
            `INSERT INTO evolution_watermarks (
              learning_scope_id, source, value, run_id, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(learning_scope_id, source) DO UPDATE SET
              value = excluded.value,
              run_id = excluded.run_id,
              updated_at_ms = excluded.updated_at_ms`,
          )
          .run(
            params.watermark.learningScopeId,
            params.watermark.source,
            params.watermark.value,
            params.watermark.runId,
            parseEvolutionTimestamp(params.watermark.updatedAt),
          );
      })
      .immediate();
  }

  finalizeRun(
    params: {
      runId: string;
      ownerId: string;
      fencingToken: number;
      now: string;
      outcome: Extract<
        EvolutionRunOutcome,
        "completed" | "no_material_novelty"
      >;
    },
    commitKnowledge: () => void,
  ): EvolutionRun {
    const nowMs = parseEvolutionTimestamp(params.now);
    return this.database
      .transaction(() => {
        this.assertLease(params.ownerId, params.fencingToken, nowMs);
        const current = this.requireRunRow(params.runId);
        if (
          current.stage !== "validating" ||
          current.owner_id !== params.ownerId ||
          current.fencing_token !== params.fencingToken
        ) {
          throw new Error("evolution_run_finalize_fence_mismatch");
        }
        commitKnowledge();
        this.database
          .prepare(
            `UPDATE evolution_runs
             SET stage = ?, outcome = ?, updated_at_ms = ?,
                 completed_at_ms = ?, owner_id = NULL, fencing_token = NULL
             WHERE run_id = ?`,
          )
          .run(params.outcome, params.outcome, nowMs, nowMs, params.runId);
        this.expireLease(params.ownerId, params.fencingToken, nowMs);
        return this.requireRun(params.runId);
      })
      .immediate();
  }

  private recoverExpiredRunsAt(nowMs: number): number {
    const result = this.database
      .prepare(
        `UPDATE evolution_runs
         SET stage = 'queued', updated_at_ms = ?,
             owner_id = NULL, fencing_token = NULL
         WHERE stage IN (${placeholders(EVOLUTION_ACTIVE_STAGES.length)})
           AND (
             owner_id IS NULL OR fencing_token IS NULL OR NOT EXISTS (
               SELECT 1 FROM evolution_leases
               WHERE lease_key = ? AND owner_id = evolution_runs.owner_id
                 AND fencing_token = evolution_runs.fencing_token
                 AND expires_at_ms > ?
             )
           )`,
      )
      .run(nowMs, ...EVOLUTION_ACTIVE_STAGES, GLOBAL_LEASE_KEY, nowMs);
    return result.changes;
  }

  private getLease(): EvolutionLeaseRow | null {
    return (
      (this.database
        .prepare(
          `SELECT owner_id, fencing_token, expires_at_ms
           FROM evolution_leases WHERE lease_key = ?`,
        )
        .get(GLOBAL_LEASE_KEY) as EvolutionLeaseRow | undefined) ?? null
    );
  }

  private assertLease(
    ownerId: string,
    fencingToken: number,
    nowMs: number,
  ): void {
    const lease = this.getLease();
    if (
      !lease ||
      lease.owner_id !== ownerId ||
      lease.fencing_token !== fencingToken ||
      lease.expires_at_ms <= nowMs
    ) {
      throw new Error("evolution_lease_lost");
    }
  }

  private expireLease(
    ownerId: string,
    fencingToken: number,
    nowMs: number,
  ): void {
    this.database
      .prepare(
        `UPDATE evolution_leases SET expires_at_ms = ?
         WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?`,
      )
      .run(nowMs, GLOBAL_LEASE_KEY, ownerId, fencingToken);
  }

  private requireRun(runId: string): EvolutionRun {
    return toRun(this.requireRunRow(runId));
  }

  private requireRunRow(runId: string): EvolutionRunRow {
    const row = this.database
      .prepare("SELECT * FROM evolution_runs WHERE run_id = ?")
      .get(runId) as EvolutionRunRow | undefined;
    if (!row) throw new Error("evolution_run_not_found");
    return row;
  }
}
