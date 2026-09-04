import type Database from "better-sqlite3";
import type {
  ActivityEvolutionEvidenceAvailability,
  ActivityEvolutionSnapshotPage,
  ActivityEvolutionSnapshotQuery,
} from "@runweave/shared/activity";
import { EVOLUTION_GLOBAL_SCOPE_ID } from "@runweave/shared/evolution";
import {
  buildTerminalChildProjectIdPrefix,
  resolveTerminalParentProjectId,
} from "@runweave/shared/terminal/project-context";
import {
  activeDeleteTombstoneSql,
  type FactRow,
  rowToFact,
} from "./query";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function queryActivityEvolutionSnapshot(
  database: Database.Database,
  query: ActivityEvolutionSnapshotQuery,
): ActivityEvolutionSnapshotPage {
  const learningScopeId = query.learningScopeId.trim();
  if (
    !learningScopeId ||
    (learningScopeId !== EVOLUTION_GLOBAL_SCOPE_ID &&
      resolveTerminalParentProjectId(learningScopeId) !== learningScopeId)
  ) {
    throw new Error("activity_evolution_invalid_learning_scope");
  }
  if (!Number.isSafeInteger(query.afterWatermark) || query.afterWatermark < 0) {
    throw new Error("activity_evolution_invalid_watermark");
  }
  if (
    query.atOrBeforeSnapshotBoundary !== undefined &&
    (!Number.isSafeInteger(query.atOrBeforeSnapshotBoundary) ||
      query.atOrBeforeSnapshotBoundary < 0)
  ) {
    throw new Error("activity_evolution_invalid_snapshot_boundary");
  }
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 1_000
  ) {
    throw new Error("activity_evolution_invalid_limit");
  }
  const eventNames = [...new Set(query.eventNames)];
  if (eventNames.length === 0 || eventNames.length > 64) {
    throw new Error("activity_evolution_invalid_event_names");
  }

  const maxOffset = Number(
    (
      database
        .prepare(
          "SELECT COALESCE(MAX(activity_offset), 0) AS value FROM behavior_facts",
        )
        .get() as { value: number }
    ).value,
  );
  const snapshotBoundary = Math.min(
    query.atOrBeforeSnapshotBoundary ?? maxOffset,
    maxOffset,
  );
  const eventNameParams = Object.fromEntries(
    eventNames.map((eventName, index) => [`eventName${index}`, eventName]),
  );
  const eventNamePlaceholders = eventNames
    .map((_, index) => `@eventName${index}`)
    .join(", ");
  const projectFilter =
    learningScopeId === EVOLUTION_GLOBAL_SCOPE_ID
      ? ""
      : `AND (
           fact.project_id = @learningScopeId
           OR fact.project_id LIKE @childProjectIdPattern ESCAPE '\\'
         )`;
  const rows = database
    .prepare(
      `SELECT fact.* FROM behavior_facts fact
       WHERE fact.activity_offset > @afterWatermark
         AND fact.activity_offset <= @snapshotBoundary
         ${projectFilter}
         AND fact.event_name IN (${eventNamePlaceholders})
         AND ${activeDeleteTombstoneSql()}
       ORDER BY fact.activity_offset ASC
       LIMIT @rowLimit`,
    )
    .all({
      afterWatermark: query.afterWatermark,
      snapshotBoundary,
      learningScopeId,
      childProjectIdPattern: `${escapeLikePattern(buildTerminalChildProjectIdPrefix(learningScopeId))}%`,
      ...eventNameParams,
      rowLimit: query.limit + 1,
    }) as FactRow[];
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const last = pageRows.at(-1);
  return {
    learningScopeId,
    afterWatermark: query.afterWatermark,
    snapshotBoundary,
    facts: pageRows.map((row) => rowToFact(database, row)),
    hasMore,
    ...(last ? { nextWatermark: last.activity_offset } : {}),
  };
}

export function queryActivityEvolutionEvidenceAvailability(
  database: Database.Database,
  requestedEventIds: string[],
): ActivityEvolutionEvidenceAvailability[] {
  const eventIds = [...new Set(requestedEventIds.map((value) => value.trim()))];
  if (
    eventIds.length === 0 ||
    eventIds.length > 1_000 ||
    eventIds.some((value) => value.length === 0)
  ) {
    throw new Error("activity_evolution_invalid_evidence_ids");
  }
  const placeholders = eventIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT fact.event_id,
              CASE WHEN ${activeDeleteTombstoneSql()} THEN 1 ELSE 0 END AS active,
              COUNT(content.content_id) AS content_count,
              SUM(CASE WHEN content.current_availability = 'available' THEN 1 ELSE 0 END)
                AS available_content_count,
              SUM(CASE WHEN content.current_availability = 'deleted' THEN 1 ELSE 0 END)
                AS deleted_content_count
       FROM behavior_facts fact
       LEFT JOIN activity_contents content
         ON content.owner_event_id = fact.event_id
       WHERE fact.event_id IN (${placeholders})
       GROUP BY fact.event_id`,
    )
    .all(...eventIds) as Array<{
    event_id: string;
    active: number;
    content_count: number;
    available_content_count: number;
    deleted_content_count: number;
  }>;
  const byEventId = new Map(rows.map((row) => [row.event_id, row]));
  return eventIds.map((eventId) => {
    const row = byEventId.get(eventId);
    if (!row) {
      return {
        eventId,
        availability: "unavailable",
        reason: "missing",
        contentCount: 0,
        availableContentCount: 0,
      };
    }
    const contentUnavailable =
      row.content_count > 0 && row.available_content_count === 0;
    const availability =
      row.active === 1 && !contentUnavailable ? "available" : "unavailable";
    const reason =
      row.active !== 1
        ? "deleted"
        : !contentUnavailable
          ? "available"
          : row.deleted_content_count > 0
            ? "deleted"
            : "expired";
    return {
      eventId,
      availability,
      reason,
      contentCount: row.content_count,
      availableContentCount: row.available_content_count,
    };
  });
}
