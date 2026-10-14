import type Database from "better-sqlite3";
import type {
  CandidateAsset,
  ContributionEdge,
  EvolutionRun,
  EvolutionRepositoryAttribution,
  Insight,
  InsightRevision,
} from "@runweave/shared/evolution";
import type {
  EvolutionEvidenceDependency,
  EvolutionEvidenceReconciliation,
  EvolutionRunKnowledgeCommit,
} from "../analysis-store";
import { readRepositoryAttribution } from "./repository-database";
import { insertImmutable } from "./database-helpers";
import { EvolutionFoundationDatabase } from "./foundation-database";

interface InsightRow {
  insight_id: string;
  learning_scope_id: string;
  topic_key: string;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
}

export class EvolutionKnowledgeDatabase {
  constructor(
    private readonly database: Database.Database,
    private readonly foundation: EvolutionFoundationDatabase,
  ) {}

  listCandidates(): CandidateAsset[] {
    const rows = this.database
      .prepare(
        `SELECT payload_json
         FROM (
           SELECT payload_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY asset_id
                    ORDER BY updated_at DESC, rowid DESC
                  ) AS current_revision
           FROM candidate_asset_revisions
         )
         WHERE current_revision = 1`,
      )
      .all() as Array<{ payload_json: string }>;
    const candidates = rows.map(
      (row) => JSON.parse(row.payload_json) as CandidateAsset,
    );
    if (candidates.length === 0) return [];
    const bindings = this.database
      .prepare(
        `SELECT id, payload_json FROM evolution_repository_bindings
       WHERE kind = 'candidate' AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(
        JSON.stringify(candidates.map((candidate) => candidate.assetId)),
      ) as Array<{ id: string; payload_json: string }>;
    const attributions = new Map(
      bindings.map((row) => [
        row.id,
        JSON.parse(row.payload_json) as EvolutionRepositoryAttribution,
      ]),
    );
    return candidates.map((candidate) => {
      const attribution = attributions.get(candidate.assetId);
      return attribution ? { ...candidate, attribution } : candidate;
    });
  }

  putCandidate(candidate: CandidateAsset): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO candidate_asset_revisions
          (revision_id, asset_id, learning_scope_id, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.revisionId,
        candidate.assetId,
        candidate.learningScopeId,
        candidate.updatedAt,
        JSON.stringify(candidate),
      );
  }

  putInsightRevision(params: {
    insight: Omit<Insight, "revisions">;
    revision: InsightRevision;
    contributionEdges: ContributionEdge[];
  }): void {
    this.database
      .transaction(() => this.insertInsightRevision(params))
      .immediate();
  }

  private insertInsightRevision(params: {
    previousRevisionId?: string;
    insight: Omit<Insight, "revisions">;
    revision: InsightRevision;
    contributionEdges: ContributionEdge[];
  }): void {
    const current = this.database
      .prepare(
        `SELECT insight_id FROM insights
         WHERE learning_scope_id = ? AND topic_key = ?`,
      )
      .get(params.insight.learningScopeId, params.insight.topicKey) as
      | { insight_id: string }
      | undefined;
    if (current && current.insight_id !== params.insight.insightId) {
      throw new Error("evolution_insight_identity_conflict");
    }
    if (!current) {
      this.database
        .prepare(
          `INSERT INTO insights (
            insight_id, learning_scope_id, topic_key, current_revision_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.insight.insightId,
          params.insight.learningScopeId,
          params.insight.topicKey,
          params.revision.revisionId,
          params.insight.createdAt,
          params.insight.updatedAt,
        );
    }
    const revisionPayload = JSON.stringify(params.revision);
    insertImmutable(this.database, {
      table: "insight_revisions",
      idColumn: "revision_id",
      id: params.revision.revisionId,
      payload: revisionPayload,
      insert: () =>
        this.database
          .prepare(
            `INSERT INTO insight_revisions (
              revision_id, insight_id, run_id, created_at, payload_json
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            params.revision.revisionId,
            params.revision.insightId,
            params.revision.runId,
            params.revision.createdAt,
            revisionPayload,
          ),
    });
    for (const edge of params.contributionEdges) {
      const payload = JSON.stringify(edge);
      insertImmutable(this.database, {
        table: "contribution_edges",
        idColumn: "edge_id",
        id: edge.edgeId,
        payload,
        insert: () =>
          this.database
            .prepare(
              `INSERT INTO contribution_edges (
                edge_id, insight_revision_id, evidence_id,
                availability, created_at, payload_json
              ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              edge.edgeId,
              edge.insightRevisionId,
              edge.evidenceId,
              edge.availability,
              edge.createdAt,
              payload,
            ),
      });
    }
    this.database
      .prepare(
        `UPDATE insights
         SET current_revision_id = ?, updated_at = ?
         WHERE insight_id = ? AND updated_at <= ?
           AND (? IS NULL OR current_revision_id = ?)`,
      )
      .run(
        params.revision.revisionId,
        params.insight.updatedAt,
        params.insight.insightId,
        params.insight.updatedAt,
        params.previousRevisionId ?? null,
        params.previousRevisionId ?? null,
      );
  }

  listInsights(learningScopeId?: string): Insight[] {
    const rows = learningScopeId
      ? (this.database
          .prepare(
            `SELECT * FROM insights
             WHERE learning_scope_id = ? ORDER BY updated_at DESC`,
          )
          .all(learningScopeId) as InsightRow[])
      : (this.database
          .prepare("SELECT * FROM insights ORDER BY updated_at DESC")
          .all() as InsightRow[]);
    return rows.map((row) => this.toInsight(row));
  }

  getInsight(insightId: string): Insight | null {
    const row = this.database
      .prepare("SELECT * FROM insights WHERE insight_id = ?")
      .get(insightId) as InsightRow | undefined;
    return row ? this.toInsight(row) : null;
  }

  listInsightRevisionsByRun(runId: string): InsightRevision[] {
    return this.readPayloadRows<InsightRevision>(
      `SELECT payload_json FROM insight_revisions
       WHERE run_id = ? ORDER BY created_at, revision_id`,
      runId,
    );
  }

  listEvidenceDependencies(): EvolutionEvidenceDependency[] {
    const candidates = this.listCandidates();
    const candidatesByRevision = new Map<string, CandidateAsset[]>();
    for (const candidate of candidates) {
      const group = candidatesByRevision.get(candidate.insightRevisionId) ?? [];
      group.push(candidate);
      candidatesByRevision.set(candidate.insightRevisionId, group);
    }
    const insights = this.database
      .prepare("SELECT * FROM insights ORDER BY updated_at DESC")
      .all() as InsightRow[];
    if (insights.length === 0) return [];
    const revisionIds = [
      ...new Set([
        ...insights.map((insight) => insight.current_revision_id),
        ...candidatesByRevision.keys(),
      ]),
    ];
    // One JSON parameter keeps large histories below SQLite's bind-variable limit.
    const rows = this.database
      .prepare(
        `SELECT insight_id, payload_json FROM insight_revisions
       WHERE revision_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at, revision_id`,
      )
      .all(JSON.stringify(revisionIds)) as Array<{
      insight_id: string;
      payload_json: string;
    }>;
    const revisionsByInsight = new Map<string, InsightRevision[]>();
    for (const row of rows) {
      const group = revisionsByInsight.get(row.insight_id) ?? [];
      group.push(JSON.parse(row.payload_json) as InsightRevision);
      revisionsByInsight.set(row.insight_id, group);
    }
    const dependencies = insights.flatMap((insight) =>
      (revisionsByInsight.get(insight.insight_id) ?? [])
        .filter(
          (revision) =>
            revision.insightId === insight.insight_id &&
            (revision.revisionId === insight.current_revision_id ||
              candidatesByRevision.has(revision.revisionId)),
        )
        .map((revision) => ({
          insight: {
            insightId: insight.insight_id,
            learningScopeId: insight.learning_scope_id,
            topicKey: insight.topic_key,
            currentRevisionId: insight.current_revision_id,
            createdAt: insight.created_at,
            updatedAt: insight.updated_at,
          },
          revision,
          candidates: candidatesByRevision.get(revision.revisionId) ?? [],
        })),
    );
    if (dependencies.length === 0) return [];
    const edges = this.database
      .prepare(
        `SELECT insight_revision_id, payload_json FROM contribution_edges
       WHERE insight_revision_id IN (SELECT value FROM json_each(?)) ORDER BY edge_id`,
      )
      .all(
        JSON.stringify(dependencies.map((item) => item.revision.revisionId)),
      ) as Array<{ insight_revision_id: string; payload_json: string }>;
    const edgesByRevision = new Map<string, ContributionEdge[]>();
    for (const row of edges) {
      const group = edgesByRevision.get(row.insight_revision_id) ?? [];
      group.push(JSON.parse(row.payload_json) as ContributionEdge);
      edgesByRevision.set(row.insight_revision_id, group);
    }
    return dependencies.map((dependency) => ({
      ...dependency,
      contributionEdges:
        edgesByRevision.get(dependency.revision.revisionId) ?? [],
    }));
  }

  applyEvidenceReconciliation(
    reconciliation: EvolutionEvidenceReconciliation,
  ): void {
    this.database
      .transaction(() => {
        for (const insight of reconciliation.insights) {
          this.insertInsightRevision(insight);
        }
        const revisionIds = new Set(
          reconciliation.insights.map((item) => item.revision.revisionId),
        );
        for (const candidate of reconciliation.candidates) {
          if (!revisionIds.has(candidate.insightRevisionId)) {
            throw new Error("evolution_reconciled_candidate_revision_mismatch");
          }
          this.putCandidate(candidate);
        }
      })
      .immediate();
  }

  commitRunKnowledge(params: EvolutionRunKnowledgeCommit): EvolutionRun {
    if (
      params.outcome === "no_material_novelty" &&
      (params.insights.length > 0 || params.candidates.length > 0)
    ) {
      throw new Error("evolution_no_material_novelty_has_output");
    }
    return this.foundation.finalizeRun(params, () => {
      for (const insight of params.insights) {
        if (insight.revision.runId !== params.runId) {
          throw new Error("evolution_insight_run_mismatch");
        }
        this.insertInsightRevision(insight);
      }
      const committedRevisionIds = new Set(
        params.insights.map((item) => item.revision.revisionId),
      );
      for (const candidate of params.candidates) {
        if (!committedRevisionIds.has(candidate.insightRevisionId)) {
          throw new Error("evolution_candidate_revision_mismatch");
        }
        this.putCandidate(candidate);
      }
      if (params.watermark) {
        if (params.watermark.runId !== params.runId) {
          throw new Error("evolution_watermark_run_mismatch");
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
            Date.parse(params.watermark.updatedAt),
          );
      }
    });
  }

  private toInsight(row: InsightRow): Insight {
    const membership = this.database
      .prepare(
        "SELECT canonical_insight_id FROM evolution_topic_lineage WHERE legacy_insight_id=?",
      )
      .get(row.insight_id) as { canonical_insight_id: string } | undefined;
    const members = membership
      ? (this.database
          .prepare(
            "SELECT legacy_insight_id, status FROM evolution_topic_lineage WHERE canonical_insight_id=? ORDER BY legacy_insight_id",
          )
          .all(membership.canonical_insight_id) as Array<{
          legacy_insight_id: string;
          status: "resolved" | "contested";
        }>)
      : [];
    const attribution = readRepositoryAttribution(
      this.database,
      "insight",
      row.insight_id,
    );
    return {
      ...(attribution ? { attribution } : {}),
      ...(membership
        ? {
            lineage: {
              canonicalInsightId: membership.canonical_insight_id,
              memberIds: members.map((member) => member.legacy_insight_id),
              status: members.some((member) => member.status === "contested")
                ? ("contested" as const)
                : ("resolved" as const),
            },
          }
        : {}),
      insightId: row.insight_id,
      learningScopeId: row.learning_scope_id,
      ...(/^[a-f0-9]{64}$/u.test(row.learning_scope_id)
        ? { repositoryId: row.learning_scope_id }
        : {}),
      topicKey: row.topic_key,
      currentRevisionId: row.current_revision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revisions: this.readPayloadRows<InsightRevision>(
        `SELECT payload_json FROM insight_revisions
         WHERE insight_id = ? OR insight_id IN (
           SELECT legacy_insight_id FROM evolution_topic_lineage WHERE canonical_insight_id = ?
         ) ORDER BY created_at, revision_id`,
        row.insight_id,
        row.insight_id,
      ),
    };
  }

  private readPayloadRows<T>(sql: string, ...values: string[]): T[] {
    const rows = this.database.prepare(sql).all(...values) as Array<{
      payload_json: string;
    }>;
    return rows.map((row) => JSON.parse(row.payload_json) as T);
  }
}
