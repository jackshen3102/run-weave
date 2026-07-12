import fs from "node:fs";
import type Database from "better-sqlite3";
import type {
  ActivityContentDescriptorDto,
  ActivityContentValueDto,
  ActivityDataPolicyDto,
  ActivityExternalRefDescriptorDto,
  ActivityFactDto,
  ActivityFactsPage,
  ActivityFactsQuery,
  ActivityPayload,
  ActivitySourceDto,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import { ACTIVITY_RETENTION_DAYS } from "@runweave/shared/activity";
import { ACTIVITY_USER_VERSION } from "./migrations";
import { decryptActivityValue } from "./crypto";

interface FactRow {
  activity_offset: number;
  event_id: string;
  event_name: ActivityFactDto["eventName"];
  schema_version: number;
  occurred_at_ms: number;
  ingested_at_ms: number;
  producer_name: string;
  producer_version: string;
  producer_instance_id: string;
  producer_boot_id: string;
  producer_sequence: number;
  actor_type: ActivityFactDto["actor"]["type"];
  actor_agent: ActivityFactDto["actor"]["agent"] | null;
  runtime_channel: ActivityFactDto["runtime"]["channel"];
  runtime_surface: ActivityFactDto["runtime"]["surface"];
  app_version: string | null;
  source_revision: string | null;
  backend_profile_id: string | null;
  cwd: string | null;
  project_id: string | null;
  terminal_session_id: string | null;
  panel_id: string | null;
  tmux_pane_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  interaction_id: string | null;
  run_id: string | null;
  operation_id: string | null;
  browser_group_id: string | null;
  tab_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  parent_event_id: string | null;
  result_status: ActivityFactDto["result"] extends { status: infer T } ? T : never;
  result_code: string | null;
  payload_json: string;
  privacy_classification: ActivityFactDto["privacyClassification"];
  retention_class: ActivityFactDto["retentionClass"];
  expires_at_ms: number;
}

interface QueryParts {
  where: string[];
  params: Record<string, string | number>;
}

function encodeCursor(occurredAt: number, activityOffset: number): string {
  return Buffer.from(JSON.stringify([occurredAt, activityOffset]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [number, number] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(parsed) && parsed.length === 2 &&
      parsed.every((value) => typeof value === "number" && Number.isSafeInteger(value))
    ) {
      return parsed as [number, number];
    }
  } catch {
    // Fall through to the stable public error.
  }
  throw new Error("activity_invalid_cursor");
}

function activeDeleteTombstoneSql(): string {
  return `NOT EXISTS (
    SELECT 1 FROM activity_delete_jobs job
    WHERE job.status IN ('pending', 'running', 'blocked')
      AND fact.activity_offset <= job.as_of_activity_offset
      AND ((job.scope_type = 'project' AND job.scope_id = fact.project_id)
        OR (job.scope_type = 'thread' AND job.scope_id = fact.thread_id))
  )`;
}

export function queryActivityContent(
  database: Database.Database,
  contentId: string,
  contentKey: Buffer | null,
): ActivityContentValueDto | null {
  const row = database.prepare(
    `SELECT content.content_id, content.owner_event_id, content.owner_role,
      content.media_type, content.byte_length, content.sha256,
      content.current_availability, content.expires_at_ms,
      content.ciphertext, content.nonce, content.auth_tag
     FROM activity_contents content
     JOIN behavior_facts fact ON fact.event_id = content.owner_event_id
     WHERE content.content_id = ? AND ${activeDeleteTombstoneSql()}`,
  ).get(contentId) as {
    content_id: string;
    owner_event_id: string;
    owner_role: ActivityContentDescriptorDto["role"];
    media_type: string;
    byte_length: number;
    sha256: string;
    current_availability: ActivityContentDescriptorDto["availability"];
    expires_at_ms: number;
    ciphertext: Buffer | null;
    nonce: Buffer | null;
    auth_tag: Buffer | null;
  } | undefined;
  if (!row) return null;
  const descriptor: ActivityContentValueDto = {
    contentId: row.content_id,
    eventId: row.owner_event_id,
    role: row.owner_role,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    availability: row.current_availability,
    expectedExpiresAt: new Date(row.expires_at_ms).toISOString(),
  };
  if (row.current_availability !== "available") return descriptor;
  if (!contentKey || !row.ciphertext || !row.nonce || !row.auth_tag) {
    throw new Error("activity_content_key_unavailable");
  }
  return {
    ...descriptor,
    bytesBase64: decryptActivityValue(
      { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag },
      contentKey,
    ).toString("base64"),
  };
}

function buildQueryParts(query: ActivityFactsQuery, asOf: number): QueryParts {
  const where = ["fact.activity_offset <= @asOf", activeDeleteTombstoneSql()];
  const params: Record<string, string | number> = { asOf };
  const filters: Array<[keyof ActivityFactsQuery, string]> = [
    ["runtimeChannel", "runtime_channel"],
    ["runtimeSurface", "runtime_surface"],
    ["projectId", "project_id"],
    ["terminalSessionId", "terminal_session_id"],
    ["threadId", "thread_id"],
    ["runId", "run_id"],
    ["eventName", "event_name"],
    ["actorType", "actor_type"],
    ["resultStatus", "result_status"],
  ];
  for (const [key, column] of filters) {
    const value = query[key];
    if (typeof value === "string" && value) {
      where.push(`fact.${column} = @${key}`);
      params[key] = value;
    }
  }
  if (query.search) {
    where.push(`(fact.event_name LIKE @search ESCAPE '\\'
      OR fact.event_id LIKE @search ESCAPE '\\'
      OR COALESCE(fact.project_id, '') LIKE @search ESCAPE '\\'
      OR COALESCE(fact.thread_id, '') LIKE @search ESCAPE '\\')`);
    params.search = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
  }
  if (query.cursor) {
    const [cursorOccurredAt, cursorOffset] = decodeCursor(query.cursor);
    where.push(`(fact.occurred_at_ms < @cursorOccurredAt OR
      (fact.occurred_at_ms = @cursorOccurredAt AND fact.activity_offset < @cursorOffset))`);
    params.cursorOccurredAt = cursorOccurredAt;
    params.cursorOffset = cursorOffset;
  }
  return { where, params };
}

function readContentDescriptors(
  database: Database.Database,
  eventId: string,
): ActivityContentDescriptorDto[] {
  const rows = database.prepare(
    `SELECT content.content_id, link.role, content.media_type, content.byte_length,
      content.sha256, content.current_availability, link.expected_expires_at_ms
     FROM fact_content_links link
     JOIN activity_contents content ON content.content_id = link.content_id
     WHERE link.event_id = ? ORDER BY link.ordinal`,
  ).all(eventId) as Array<{
    content_id: string;
    role: ActivityContentDescriptorDto["role"];
    media_type: string;
    byte_length: number;
    sha256: string;
    current_availability: ActivityContentDescriptorDto["availability"];
    expected_expires_at_ms: number;
  }>;
  return rows.map((row) => ({
    contentId: row.content_id,
    role: row.role,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    availability: row.current_availability,
    expectedExpiresAt: new Date(row.expected_expires_at_ms).toISOString(),
  }));
}

function readRefDescriptors(
  database: Database.Database,
  eventId: string,
): ActivityExternalRefDescriptorDto[] {
  const rows = database.prepare(
    `SELECT ref.ref_id, link.role, ref.authority, ref.version_or_digest,
      ref.current_availability
     FROM fact_external_ref_links link
     JOIN external_refs ref ON ref.ref_id = link.ref_id
     WHERE link.event_id = ? ORDER BY link.ordinal`,
  ).all(eventId) as Array<{
    ref_id: string;
    role: ActivityExternalRefDescriptorDto["role"];
    authority: ActivityExternalRefDescriptorDto["authority"];
    version_or_digest: string;
    current_availability: ActivityExternalRefDescriptorDto["availability"];
  }>;
  return rows.map((row) => ({
    refId: row.ref_id,
    role: row.role,
    authority: row.authority,
    versionOrDigest: row.version_or_digest,
    availability: row.current_availability,
  }));
}

function rowToFact(database: Database.Database, row: FactRow): ActivityFactDto {
  return {
    activityOffset: row.activity_offset,
    eventId: row.event_id,
    eventName: row.event_name,
    schemaVersion: row.schema_version,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    ingestedAt: new Date(row.ingested_at_ms).toISOString(),
    producer: {
      name: row.producer_name,
      version: row.producer_version,
      instanceId: row.producer_instance_id,
      bootId: row.producer_boot_id,
      sequence: row.producer_sequence,
    },
    actor: { type: row.actor_type, ...(row.actor_agent ? { agent: row.actor_agent } : {}) },
    runtime: {
      channel: row.runtime_channel,
      surface: row.runtime_surface,
      ...(row.app_version ? { appVersion: row.app_version } : {}),
      ...(row.source_revision ? { sourceRevision: row.source_revision } : {}),
      ...(row.backend_profile_id ? { backendProfileId: row.backend_profile_id } : {}),
    },
    scope: {
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.terminal_session_id ? { terminalSessionId: row.terminal_session_id } : {}),
      ...(row.panel_id ? { panelId: row.panel_id } : {}),
      ...(row.tmux_pane_id ? { tmuxPaneId: row.tmux_pane_id } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.interaction_id ? { interactionId: row.interaction_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.operation_id ? { operationId: row.operation_id } : {}),
      ...(row.browser_group_id ? { browserGroupId: row.browser_group_id } : {}),
      ...(row.tab_id ? { tabId: row.tab_id } : {}),
    },
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(row.parent_event_id ? { parentEventId: row.parent_event_id } : {}),
    ...(row.result_status
      ? { result: { status: row.result_status, ...(row.result_code ? { code: row.result_code } : {}) } }
      : {}),
    payload: JSON.parse(row.payload_json) as ActivityPayload,
    privacyClassification: row.privacy_classification,
    retentionClass: row.retention_class,
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    contentDescriptors: readContentDescriptors(database, row.event_id),
    externalRefDescriptors: readRefDescriptors(database, row.event_id),
  };
}

export function queryActivityFacts(
  database: Database.Database,
  query: ActivityFactsQuery,
): ActivityFactsPage {
  const maxOffset = Number(
    (database.prepare("SELECT COALESCE(MAX(activity_offset), 0) AS value FROM behavior_facts").get() as { value: number }).value,
  );
  const asOf = Math.min(query.asOfActivityOffset ?? maxOffset, maxOffset);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  const { where, params } = buildQueryParts(query, asOf);
  const rows = database.prepare(
    `SELECT fact.* FROM behavior_facts fact
     WHERE ${where.join(" AND ")}
     ORDER BY fact.occurred_at_ms DESC, fact.activity_offset DESC
     LIMIT @rowLimit`,
  ).all({ ...params, rowLimit: limit + 1 }) as FactRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    facts: pageRows.map((row) => rowToFact(database, row)),
    asOfActivityOffset: asOf,
    ...(hasMore && last
      ? { nextCursor: encodeCursor(last.occurred_at_ms, last.activity_offset) }
      : {}),
  };
}

export function queryActivityTimeline(
  database: Database.Database,
  selector: ActivityTimelineSelector,
  query: Omit<ActivityFactsQuery, "cursor"> & { cursor?: string },
): ActivityFactsPage {
  const selectorQuery: ActivityFactsQuery = { ...query };
  if (selector.type === "interaction") {
    Object.assign(selectorQuery, { search: undefined });
  }
  const column = {
    interaction: "interaction_id",
    correlation: "correlation_id",
    thread: "thread_id",
    run: "run_id",
  }[selector.type];
  const maxOffset = Number(
    (database.prepare("SELECT COALESCE(MAX(activity_offset), 0) AS value FROM behavior_facts").get() as { value: number }).value,
  );
  const asOf = Math.min(query.asOfActivityOffset ?? maxOffset, maxOffset);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  const { where, params } = buildQueryParts(selectorQuery, asOf);
  where.push(`fact.${column} = @selectorId`);
  const summaryParts = buildQueryParts({ ...selectorQuery, cursor: undefined }, asOf);
  summaryParts.where.push(`fact.${column} = @selectorId`);
  const summary = database.prepare(
    `SELECT COUNT(*) AS event_count,
      MIN(fact.occurred_at_ms) AS first_occurred_at_ms,
      MAX(fact.occurred_at_ms) AS last_occurred_at_ms,
      COUNT(fact.operation_id) AS operation_count,
      COUNT(DISTINCT fact.operation_id) AS distinct_operation_count,
      COUNT(fact.correlation_id) AS correlation_count,
      COUNT(DISTINCT fact.correlation_id) AS distinct_correlation_count
     FROM behavior_facts fact WHERE ${summaryParts.where.join(" AND ")}`,
  ).get({ ...summaryParts.params, selectorId: selector.id }) as {
    event_count: number;
    first_occurred_at_ms: number | null;
    last_occurred_at_ms: number | null;
    operation_count: number;
    distinct_operation_count: number;
    correlation_count: number;
    distinct_correlation_count: number;
  };
  const rows = database.prepare(
    `SELECT fact.* FROM behavior_facts fact WHERE ${where.join(" AND ")}
     ORDER BY fact.occurred_at_ms DESC, fact.activity_offset DESC LIMIT @rowLimit`,
  ).all({ ...params, selectorId: selector.id, rowLimit: limit + 1 }) as FactRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    facts: pageRows.map((row) => rowToFact(database, row)),
    asOfActivityOffset: asOf,
    computed: {
      eventCount: summary.event_count,
      ...(summary.event_count >= 2 &&
      summary.first_occurred_at_ms !== null &&
      summary.last_occurred_at_ms !== null &&
      ((summary.operation_count === summary.event_count &&
        summary.distinct_operation_count === 1) ||
        (summary.correlation_count === summary.event_count &&
          summary.distinct_correlation_count === 1))
        ? { durationMs: summary.last_occurred_at_ms - summary.first_occurred_at_ms }
        : {}),
    },
    ...(hasMore && last ? { nextCursor: encodeCursor(last.occurred_at_ms, last.activity_offset) } : {}),
  };
}

export function queryActivitySources(database: Database.Database): ActivitySourceDto[] {
  const rows = database.prepare(
    `SELECT producer.*,
       (SELECT COUNT(*) FROM source_gaps gap
        WHERE gap.producer_instance_id = producer.producer_instance_id
          AND gap.producer_boot_id = producer.producer_boot_id
          AND gap.status = 'open') AS open_gap_count,
       (SELECT COUNT(*) FROM ingest_rejections rejection
        WHERE rejection.producer_instance_id = producer.producer_instance_id) AS rejection_count
     FROM producer_instances producer
     ORDER BY producer.last_seen_at_ms DESC`,
  ).all() as Array<{
    producer_instance_id: string;
    producer_boot_id: string;
    producer_name: string;
    producer_version: string;
    runtime_channel: ActivitySourceDto["runtimeChannel"];
    runtime_surface: ActivitySourceDto["runtimeSurface"];
    first_seen_at_ms: number;
    last_seen_at_ms: number;
    highest_seen_sequence: number;
    highest_contiguous_sequence: number;
    open_gap_count: number;
    rejection_count: number;
    last_commit_latency_ms: number | null;
    last_error_code: string | null;
  }>;
  const readGaps = database.prepare(
    `SELECT first_sequence, last_sequence, status, reason_code
     FROM source_gaps
     WHERE producer_instance_id = ? AND producer_boot_id = ?
     ORDER BY first_sequence`,
  );
  return rows.map((row) => ({
    producerInstanceId: row.producer_instance_id,
    producerBootId: row.producer_boot_id,
    producerName: row.producer_name,
    producerVersion: row.producer_version,
    runtimeChannel: row.runtime_channel,
    runtimeSurface: row.runtime_surface,
    firstSeenAt: new Date(row.first_seen_at_ms).toISOString(),
    lastSeenAt: new Date(row.last_seen_at_ms).toISOString(),
    highestSeenSequence: row.highest_seen_sequence,
    highestContiguousSequence: row.highest_contiguous_sequence,
    openGapCount: row.open_gap_count,
    rejectionCount: row.rejection_count,
    gapRanges: (readGaps.all(
      row.producer_instance_id,
      row.producer_boot_id,
    ) as Array<{
      first_sequence: number;
      last_sequence: number;
      status: "open" | "closed";
      reason_code: string | null;
    }>).map((gap) => ({
      firstSequence: gap.first_sequence,
      lastSequence: gap.last_sequence,
      status: gap.status,
      ...(gap.reason_code ? { reasonCode: gap.reason_code } : {}),
    })),
    ...(row.last_commit_latency_ms != null ? { lastCommitLatencyMs: row.last_commit_latency_ms } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
  }));
}

export function queryActivityDataPolicy(
  database: Database.Database,
  databasePath: string,
): ActivityDataPolicyDto {
  const pendingDeleteJobs = Number(
    (database.prepare("SELECT COUNT(*) AS value FROM activity_delete_jobs WHERE status != 'completed'").get() as { value: number }).value,
  );
  return {
    available: true,
    databasePathLabel: "~/.runweave/activity/activity.sqlite",
    factRetentionDays: ACTIVITY_RETENTION_DAYS.fact,
    contentRetentionDays: ACTIVITY_RETENTION_DAYS.content,
    databaseBytes: fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0,
    journalMode: String(database.pragma("journal_mode", { simple: true })),
    schemaVersion: ACTIVITY_USER_VERSION,
    pendingDeleteJobs,
  };
}
