import type Database from "better-sqlite3";
import type {
  ContextPackSummary,
  EvolutionArtifactOverview,
  EvolutionArtifactPage,
  EvolutionArtifactPageQuery,
} from "@runweave/shared/evolution";

const PAGE_BYTES = 512 * 1024;
interface Cursor {
  runId: string;
  collection: string;
  offset: number;
  boundary: number | string;
}

/** Bounded read projections; the immutable manifest remains the source of truth. */
export class EvolutionArtifactReads {
  private readonly summaries = new Map<
    string,
    { digest: string; value: ContextPackSummary }
  >();
  constructor(private readonly database: Database.Database) {}

  overview(runId: string): EvolutionArtifactOverview {
    const cacheAllowed = !this.database.inTransaction;
    return this.database.transaction(() => ({
      contextPack: this.summary(runId, cacheAllowed),
      segmentCount: this.count("trace_segments", runId),
      episodeCount: this.count("episodes", runId),
    }))();
  }

  private count(
    table: "trace_segments" | "episodes",
    runId: string,
    boundary?: number,
  ): number {
    return (
      this.database
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?
      ${boundary === undefined ? "" : "AND rowid <= ?"}`,
        )
        .get(...(boundary === undefined ? [runId] : [runId, boundary])) as {
        n: number;
      }
    ).n;
  }

  private summary(
    runId: string,
    cacheAllowed: boolean,
  ): ContextPackSummary | null {
    const identity = this.database
      .prepare(
        "SELECT context_pack_id, digest FROM context_packs WHERE run_id = ?",
      )
      .get(runId) as { context_pack_id: string; digest: string } | undefined;
    if (!identity) return null;
    const cached = this.summaries.get(identity.context_pack_id);
    if (cacheAllowed && cached?.digest === identity.digest) return cached.value;
    // Strip large arrays in SQLite, before crossing the native/JS and worker boundaries.
    const row = this.database
      .prepare(
        `SELECT
      json_remove(manifest_json, '$.evidence', '$.dataQualityIssues') AS metadata,
      json_array_length(manifest_json, '$.evidence') AS evidenceCount,
      json_array_length(manifest_json, '$.dataQualityIssues') AS dataQualityIssueCount
      FROM context_packs WHERE run_id = ?`,
      )
      .get(runId) as {
      metadata: string;
      evidenceCount: number;
      dataQualityIssueCount: number;
    };
    const workspaceCount = (
      this.database
        .prepare(
          `SELECT COUNT(DISTINCT json_extract(item.value, '$.origin.projectId')) AS n
      FROM context_packs pack, json_each(pack.manifest_json, '$.evidence') item
      WHERE pack.run_id = ? AND json_extract(item.value, '$.source') = 'activity'
        AND json_extract(item.value, '$.origin.projectId') != ''`,
        )
        .get(runId) as { n: number }
    ).n;
    const dataQualitySummary = this.database
      .prepare(
        `SELECT json_extract(item.value, '$.code') AS code,
      COUNT(*) AS count, json_extract(item.value, '$.detail') AS detail, MIN(CAST(item.key AS INTEGER)) AS firstIndex
      FROM context_packs pack, json_each(pack.manifest_json, '$.dataQualityIssues') item
      WHERE pack.run_id = ? GROUP BY code`,
      )
      .all(runId) as ContextPackSummary["dataQualitySummary"];
    dataQualitySummary.sort(
      (a, b) => b.count - a.count || a.code.localeCompare(b.code),
    );
    const value: ContextPackSummary = {
      ...JSON.parse(row.metadata),
      evidenceCount: row.evidenceCount,
      dataQualityIssueCount: row.dataQualityIssueCount,
      workspaceCount,
      dataQualitySummary: dataQualitySummary.map(({ code, count, detail }) => ({
        code,
        count,
        detail,
      })),
    };
    // Only small summaries are retained. Manifests reject UPDATE at the database layer.
    if (cacheAllowed) {
      if (this.summaries.size >= 32)
        this.summaries.delete(this.summaries.keys().next().value!);
      this.summaries.set(identity.context_pack_id, {
        digest: identity.digest,
        value,
      });
    }
    return value;
  }

  page(
    runId: string,
    query: EvolutionArtifactPageQuery,
  ): EvolutionArtifactPage {
    const { collection } = query;
    if (
      !["evidence", "data-quality", "segments", "episodes"].includes(collection)
    )
      throw new Error("evolution_artifact_query_invalid");
    const limit = query.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("evolution_artifact_query_invalid");
    const cursor = query.cursor
      ? decodeCursor(query.cursor, runId, collection)
      : undefined;
    return this.database.transaction(() => {
      const offset = cursor?.offset ?? 0;
      let boundary: number | string;
      let total: number;
      let rows: Iterable<{ payload: string }>;
      if (collection === "evidence" || collection === "data-quality") {
        const pack = this.database
          .prepare(
            "SELECT context_pack_id, digest FROM context_packs WHERE run_id = ?",
          )
          .get(runId) as
          | { context_pack_id: string; digest: string }
          | undefined;
        boundary = pack ? `${pack.context_pack_id}:${pack.digest}` : "missing";
        if (cursor && cursor.boundary !== boundary)
          throw new Error("evolution_artifact_cursor_stale");
        const field =
          collection === "evidence" ? "evidence" : "dataQualityIssues";
        total = pack
          ? (
              this.database
                .prepare(
                  `SELECT json_array_length(manifest_json, '$.${field}') AS n
          FROM context_packs WHERE run_id = ?`,
                )
                .get(runId) as { n: number }
            ).n
          : 0;
        rows = this.database
          .prepare(
            `SELECT item.value AS payload FROM context_packs pack,
          json_each(pack.manifest_json, '$.${field}') item WHERE pack.run_id = ? AND CAST(item.key AS INTEGER) >= ?
          ORDER BY CAST(item.key AS INTEGER) LIMIT ?`,
          )
          .iterate(runId, offset, limit) as Iterable<{ payload: string }>;
      } else {
        const table = collection === "segments" ? "trace_segments" : "episodes";
        const order =
          collection === "segments"
            ? "sequence, segment_id"
            : "created_at, episode_id";
        boundary =
          cursor?.boundary ??
          (
            this.database
              .prepare(
                `SELECT COALESCE(MAX(rowid), 0) AS n
          FROM ${table} WHERE run_id = ?`,
              )
              .get(runId) as { n: number }
          ).n;
        if (typeof boundary !== "number")
          throw new Error("evolution_artifact_query_invalid");
        total = this.count(table, runId, boundary);
        rows = this.database
          .prepare(
            `SELECT payload_json AS payload FROM ${table}
          WHERE run_id = ? AND rowid <= ? ORDER BY ${order} LIMIT ? OFFSET ?`,
          )
          .iterate(runId, boundary, limit, offset) as Iterable<{
          payload: string;
        }>;
      }
      const items: EvolutionArtifactPage["items"] = [];
      let bytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(row.payload);
        // A single large record must remain readable; never truncate its contents.
        if (items.length > 0 && bytes + size > PAGE_BYTES) break;
        items.push(JSON.parse(row.payload));
        bytes += size;
      }
      const nextOffset = offset + items.length;
      return {
        collection,
        items,
        total,
        nextCursor:
          nextOffset < total
            ? Buffer.from(
                JSON.stringify({
                  runId,
                  collection,
                  offset: nextOffset,
                  boundary,
                }),
              ).toString("base64url")
            : null,
      };
    })();
  }
}

function decodeCursor(
  value: string,
  runId: string,
  collection: string,
): Cursor {
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (
      cursor.runId === runId &&
      cursor.collection === collection &&
      Number.isSafeInteger(cursor.offset) &&
      cursor.offset >= 0 &&
      ((typeof cursor.boundary === "string" && cursor.boundary.length <= 512) ||
        (Number.isSafeInteger(cursor.boundary) && Number(cursor.boundary) >= 0))
    )
      return cursor;
  } catch {
    /* Reject malformed and cross-run cursors with the same public error. */
  }
  throw new Error("evolution_artifact_query_invalid");
}
