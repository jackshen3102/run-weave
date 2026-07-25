import type Database from "better-sqlite3";
import type {
  ContextPackManifest,
  Episode,
  EvolutionAnalysisReport,
  EvolutionClaim,
  EvolutionClaimNovelty,
  EvolutionRunAttempt,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
  TraceSegment,
} from "@runweave/shared/evolution";
import { insertImmutable } from "./database-helpers";

export class EvolutionArtifactDatabase {
  constructor(private readonly database: Database.Database) {}

  putRuntimeTrace(trace: RuntimeTraceSummary): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO runtime_traces
            (trace_id, run_id, created_at, payload_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          trace.traceId,
          trace.runId,
          trace.createdAt,
          JSON.stringify({ ...trace, events: [] }),
        );
      for (const event of trace.events) {
        this.appendRuntimeTraceEvent(event);
      }
    })();
  }

  appendRuntimeTraceEvent(event: RuntimeTraceEvent): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO runtime_trace_events
          (event_id, trace_id, at, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.eventId, event.traceId, event.at, JSON.stringify(event));
  }

  getRuntimeTrace(traceId: string): RuntimeTraceSummary | null {
    const row = this.database
      .prepare("SELECT payload_json FROM runtime_traces WHERE trace_id = ?")
      .get(traceId) as { payload_json: string } | undefined;
    if (!row) return null;
    const trace = JSON.parse(row.payload_json) as RuntimeTraceSummary;
    return { ...trace, events: this.listEvents(traceId) };
  }

  listRuntimeTraces(runId: string): RuntimeTraceSummary[] {
    const rows = this.database
      .prepare(
        "SELECT trace_id FROM runtime_traces WHERE run_id = ? ORDER BY created_at",
      )
      .all(runId) as Array<{ trace_id: string }>;
    return rows.flatMap((row) => {
      const trace = this.getRuntimeTrace(row.trace_id);
      return trace ? [trace] : [];
    });
  }

  listRecentRuntimeTraces(
    learningScopeId: string | undefined,
    limit: number,
  ): RuntimeTraceSummary[] {
    const rows = learningScopeId
      ? (this.database
          .prepare(
            `SELECT trace_id FROM runtime_traces
             WHERE json_extract(payload_json, '$.learningScopeId') = ?
             ORDER BY created_at DESC, trace_id
             LIMIT ?`,
          )
          .all(learningScopeId, limit) as Array<{ trace_id: string }>)
      : (this.database
          .prepare(
            `SELECT trace_id FROM runtime_traces
             ORDER BY created_at DESC, trace_id
             LIMIT ?`,
          )
          .all(limit) as Array<{ trace_id: string }>);
    return rows.flatMap((row) => {
      const trace = this.getRuntimeTrace(row.trace_id);
      return trace ? [trace] : [];
    });
  }

  private listEvents(traceId: string): RuntimeTraceEvent[] {
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM runtime_trace_events
         WHERE trace_id = ? ORDER BY at, rowid`,
      )
      .all(traceId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RuntimeTraceEvent);
  }

  putContextPack(manifest: ContextPackManifest): void {
    const manifestJson = JSON.stringify(manifest);
    this.database
      .transaction(() => {
        const existing = this.database
          .prepare(
            `SELECT manifest_json FROM context_packs
             WHERE context_pack_id = ? OR run_id = ?
             LIMIT 1`,
          )
          .get(manifest.contextPackId, manifest.runId) as
          | { manifest_json: string }
          | undefined;
        if (existing) {
          if (existing.manifest_json !== manifestJson) {
            throw new Error("evolution_context_pack_identity_conflict");
          }
          return;
        }
        this.database
          .prepare(
            `INSERT INTO context_packs (
              context_pack_id, run_id, learning_scope_id, digest,
              created_at_ms, manifest_json
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            manifest.contextPackId,
            manifest.runId,
            manifest.learningScope.learningScopeId,
            manifest.digest,
            Date.parse(manifest.createdAt),
            manifestJson,
          );
        const insertSource = this.database.prepare(
          `INSERT INTO context_pack_sources (
            context_pack_id, source_id, source, boundary_json
          ) VALUES (?, ?, ?, ?)`,
        );
        for (const source of manifest.sources) {
          insertSource.run(
            manifest.contextPackId,
            source.sourceId,
            source.source,
            JSON.stringify(source),
          );
        }
      })
      .immediate();
  }

  getContextPack(contextPackId: string): ContextPackManifest | null {
    return this.readContextPack("context_pack_id", contextPackId);
  }

  getContextPackByRun(runId: string): ContextPackManifest | null {
    return this.readContextPack("run_id", runId);
  }

  private readContextPack(
    column: "context_pack_id" | "run_id",
    value: string,
  ): ContextPackManifest | null {
    const row = this.database
      .prepare(`SELECT manifest_json FROM context_packs WHERE ${column} = ?`)
      .get(value) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as ContextPackManifest) : null;
  }

  putTraceSegments(segments: TraceSegment[]): void {
    const insert = this.database.prepare(
      `INSERT INTO trace_segments (
        segment_id, run_id, learning_scope_id, sequence, payload_json
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.database
      .transaction(() => {
        for (const segment of segments) {
          insertImmutable(this.database, {
            table: "trace_segments",
            idColumn: "segment_id",
            id: segment.segmentId,
            payload: JSON.stringify(segment),
            insert: () =>
              insert.run(
                segment.segmentId,
                segment.runId,
                segment.learningScopeId,
                segment.sequence,
                JSON.stringify(segment),
              ),
          });
        }
      })
      .immediate();
  }

  listTraceSegments(runId: string): TraceSegment[] {
    return this.readPayloadRows<TraceSegment>(
      `SELECT payload_json FROM trace_segments
       WHERE run_id = ? ORDER BY sequence, segment_id`,
      runId,
    );
  }

  putEpisodes(episodes: Episode[]): void {
    const insert = this.database.prepare(
      `INSERT INTO episodes (
        episode_id, run_id, learning_scope_id, created_at, payload_json
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.database
      .transaction(() => {
        for (const episode of episodes) {
          insertImmutable(this.database, {
            table: "episodes",
            idColumn: "episode_id",
            id: episode.episodeId,
            payload: JSON.stringify(episode),
            insert: () =>
              insert.run(
                episode.episodeId,
                episode.runId,
                episode.learningScopeId,
                episode.createdAt,
                JSON.stringify(episode),
              ),
          });
        }
      })
      .immediate();
  }

  listEpisodes(runId: string): Episode[] {
    return this.readPayloadRows<Episode>(
      `SELECT payload_json FROM episodes
       WHERE run_id = ? ORDER BY created_at, episode_id`,
      runId,
    );
  }

  putAnalysisReport(report: EvolutionAnalysisReport): void {
    const payload = JSON.stringify(report);
    insertImmutable(this.database, {
      table: "analysis_reports",
      idColumn: "report_id",
      id: report.reportId,
      payload,
      insert: () =>
        this.database
          .prepare(
            `INSERT INTO analysis_reports (
              report_id, run_id, attempt_number, role, created_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            report.reportId,
            report.runId,
            report.attemptNumber,
            report.role,
            report.createdAt,
            payload,
          ),
    });
  }

  listAnalysisReports(runId: string): EvolutionAnalysisReport[] {
    return this.readPayloadRows<EvolutionAnalysisReport>(
      `SELECT payload_json FROM analysis_reports
       WHERE run_id = ? ORDER BY attempt_number, created_at, report_id`,
      runId,
    );
  }

  putRunAttempt(attempt: EvolutionRunAttempt): void {
    const existing = this.database
      .prepare(
        "SELECT payload_json FROM evolution_run_attempts WHERE attempt_id = ?",
      )
      .get(attempt.attemptId) as { payload_json: string } | undefined;
    if (!existing) {
      this.database
        .prepare(
          `INSERT INTO evolution_run_attempts (
            attempt_id, run_id, attempt_number, role, provider, status,
            started_at, completed_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.attemptId,
          attempt.runId,
          attempt.attemptNumber,
          attempt.role,
          attempt.provider,
          attempt.status,
          attempt.startedAt,
          attempt.completedAt,
          JSON.stringify(attempt),
        );
      return;
    }
    const current = JSON.parse(existing.payload_json) as EvolutionRunAttempt;
    if (
      current.runId !== attempt.runId ||
      current.attemptNumber !== attempt.attemptNumber ||
      current.role !== attempt.role ||
      current.provider !== attempt.provider ||
      current.selectionReason !== attempt.selectionReason ||
      current.startedAt !== attempt.startedAt
    ) {
      throw new Error("evolution_run_attempt_identity_conflict");
    }
    if (current.status !== "running" && current.status !== attempt.status) {
      throw new Error("evolution_run_attempt_terminal");
    }
    this.database
      .prepare(
        `UPDATE evolution_run_attempts
         SET status = ?, completed_at = ?, payload_json = ?
         WHERE attempt_id = ?`,
      )
      .run(
        attempt.status,
        attempt.completedAt,
        JSON.stringify(attempt),
        attempt.attemptId,
      );
  }

  listRunAttempts(runId: string): EvolutionRunAttempt[] {
    return this.readPayloadRows<EvolutionRunAttempt>(
      `SELECT payload_json FROM evolution_run_attempts
       WHERE run_id = ? ORDER BY attempt_number, started_at, attempt_id`,
      runId,
    );
  }

  putClaims(claims: EvolutionClaim[]): void {
    const insert = this.database.prepare(
      `INSERT INTO claims (
        claim_id, run_id, learning_scope_id, topic_key, created_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.database
      .transaction(() => {
        for (const claim of claims) {
          insertImmutable(this.database, {
            table: "claims",
            idColumn: "claim_id",
            id: claim.claimId,
            payload: JSON.stringify(claim),
            insert: () =>
              insert.run(
                claim.claimId,
                claim.runId,
                claim.learningScopeId,
                claim.topicKey,
                claim.createdAt,
                JSON.stringify(claim),
              ),
          });
        }
      })
      .immediate();
  }

  listClaims(runId: string): EvolutionClaim[] {
    return this.readPayloadRows<EvolutionClaim>(
      `SELECT payload_json FROM claims
       WHERE run_id = ? ORDER BY topic_key, claim_id`,
      runId,
    );
  }

  putClaimNovelty(items: EvolutionClaimNovelty[]): void {
    const insert = this.database.prepare(
      `INSERT INTO claim_novelty (
        claim_id, run_id, novelty, payload_json
      ) VALUES (?, ?, ?, ?)`,
    );
    this.database
      .transaction(() => {
        for (const item of items) {
          const claim = this.database
            .prepare("SELECT run_id FROM claims WHERE claim_id = ?")
            .get(item.claimId) as { run_id: string } | undefined;
          if (!claim) throw new Error("evolution_claim_not_found");
          insertImmutable(this.database, {
            table: "claim_novelty",
            idColumn: "claim_id",
            id: item.claimId,
            payload: JSON.stringify(item),
            insert: () =>
              insert.run(
                item.claimId,
                claim.run_id,
                item.novelty,
                JSON.stringify(item),
              ),
          });
        }
      })
      .immediate();
  }

  listClaimNovelty(runId: string): EvolutionClaimNovelty[] {
    return this.readPayloadRows<EvolutionClaimNovelty>(
      `SELECT payload_json FROM claim_novelty
       WHERE run_id = ? ORDER BY claim_id`,
      runId,
    );
  }

  private readPayloadRows<T>(sql: string, value: string): T[] {
    const rows = this.database.prepare(sql).all(value) as Array<{
      payload_json: string;
    }>;
    return rows.map((row) => JSON.parse(row.payload_json) as T);
  }
}
