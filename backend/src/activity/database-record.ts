import type Database from "better-sqlite3";
import type {
  ActivityEventInput,
  ActivityWriteAck,
} from "@runweave/shared/activity";
import { ACTIVITY_RETENTION_DAYS } from "@runweave/shared/activity";
import { requireActivityEventDefinition } from "./registry";
import {
  encryptActivityValue,
  type ActivityEncryptedValue,
} from "./crypto";
import { ACTIVITY_REDACTION_VERSION, redactActivityText } from "./redaction";
import { canonicalizeActivityEvent, sha256 } from "./canonical";
import { ACTIVITY_COMPATIBILITY_MAJOR } from "./migrations";

const DAY_MS = 24 * 60 * 60 * 1000;
const FACT_ENVELOPE_BYTES = 64 * 1024;
const DESCRIPTOR_ENVELOPE_BYTES = 8 * 1024;
const MAX_OWNED_MUTATION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DATABASE_BYTES = 5 * 1024 * 1024 * 1024;

interface ExistingFactRow {
  event_id: string;
  ingest_fingerprint_sha256: string;
  activity_offset: number;
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`activity_invalid_${field}`);
  }
  return timestamp;
}

function redactContent(bytes: Buffer, mediaType: string): Buffer {
  if (!mediaType.startsWith("text/") && !mediaType.includes("json")) {
    return bytes;
  }
  return Buffer.from(redactActivityText(bytes.toString("utf8")), "utf8");
}

function mutationBytes(
  payloadJson: string,
  encryptedContents: Array<{ encrypted: ActivityEncryptedValue; byteLength: number }>,
  encryptedRefs: ActivityEncryptedValue[],
): number {
  const contentBytes = encryptedContents.reduce(
    (total, entry) =>
      total +
      entry.byteLength +
      entry.encrypted.ciphertext.byteLength +
      entry.encrypted.nonce.byteLength +
      entry.encrypted.authTag.byteLength,
    0,
  );
  const refBytes = encryptedRefs.reduce(
    (total, entry) =>
      total + entry.ciphertext.byteLength + entry.nonce.byteLength + entry.authTag.byteLength,
    0,
  );
  return (
    Buffer.byteLength(payloadJson) +
    contentBytes +
    refBytes +
    FACT_ENVELOPE_BYTES +
    (encryptedContents.length + encryptedRefs.length) * DESCRIPTOR_ENVELOPE_BYTES
  );
}

function findExisting(
  database: Database.Database,
  event: ActivityEventInput,
): ExistingFactRow | undefined {
  return database
    .prepare(
      `SELECT event_id, ingest_fingerprint_sha256, activity_offset
       FROM behavior_facts
       WHERE event_id = ? OR (
         producer_instance_id = ? AND producer_boot_id = ? AND producer_sequence = ?
       )
       LIMIT 1`,
    )
    .get(
      event.eventId,
      event.producer.instanceId,
      event.producer.bootId,
      event.producer.sequence,
    ) as ExistingFactRow | undefined;
}

function upsertProducer(
  database: Database.Database,
  event: ActivityEventInput,
  ingestedAt: number,
): void {
  const expiresAt = ingestedAt + ACTIVITY_RETENTION_DAYS.fact * DAY_MS;
  database
    .prepare(
      `INSERT INTO producer_instances (
        producer_instance_id, producer_boot_id, producer_name, producer_version,
        runtime_channel, runtime_surface, boot_started_at_ms, started_event_id,
        first_seen_at_ms, last_seen_at_ms, highest_seen_sequence,
        highest_contiguous_sequence, last_commit_latency_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(producer_instance_id, producer_boot_id) DO UPDATE SET
        last_seen_at_ms = MAX(last_seen_at_ms, excluded.last_seen_at_ms),
        highest_seen_sequence = MAX(highest_seen_sequence, excluded.highest_seen_sequence),
        highest_contiguous_sequence = CASE
          WHEN excluded.highest_seen_sequence = highest_contiguous_sequence + 1
            THEN excluded.highest_seen_sequence
          ELSE highest_contiguous_sequence
        END,
        expires_at_ms = MAX(expires_at_ms, excluded.expires_at_ms)`,
    )
    .run(
      event.producer.instanceId,
      event.producer.bootId,
      event.producer.name,
      event.producer.version,
      event.runtime.channel,
      event.runtime.surface,
      parseTimestamp(event.producer.bootStartedAt, "boot_started_at"),
      event.eventName === "producer.instance.started" ? event.eventId : null,
      ingestedAt,
      ingestedAt,
      event.producer.sequence,
      event.producer.sequence === 1 ? 1 : 0,
      expiresAt,
    );
}

function recordGapIfNeeded(
  database: Database.Database,
  event: ActivityEventInput,
  ingestedAt: number,
): void {
  const producer = database
    .prepare(
      `SELECT highest_contiguous_sequence AS contiguous
       FROM producer_instances WHERE producer_instance_id = ? AND producer_boot_id = ?`,
    )
    .get(event.producer.instanceId, event.producer.bootId) as { contiguous: number };
  if (event.producer.sequence <= producer.contiguous + 1) {
    return;
  }
  const first = producer.contiguous + 1;
  const last = event.producer.sequence - 1;
  const existingGap = database.prepare(
    `SELECT gap_id, last_sequence FROM source_gaps
     WHERE producer_instance_id = ? AND producer_boot_id = ?
       AND status = 'open' AND first_sequence <= ?
     ORDER BY first_sequence LIMIT 1`,
  ).get(
    event.producer.instanceId,
    event.producer.bootId,
    last + 1,
  ) as { gap_id: string; last_sequence: number } | undefined;
  if (existingGap) {
    database.prepare(
      `UPDATE source_gaps SET last_sequence = MAX(last_sequence, ?),
        expires_at_ms = MAX(expires_at_ms, ?)
       WHERE gap_id = ?`,
    ).run(
      last,
      ingestedAt + ACTIVITY_RETENTION_DAYS.fact * DAY_MS,
      existingGap.gap_id,
    );
    return;
  }
  const gapId = sha256(
    `${event.producer.instanceId}:${event.producer.bootId}:${first}:${last}`,
  );
  database
    .prepare(
      `INSERT OR IGNORE INTO source_gaps (
        gap_id, producer_instance_id, producer_boot_id, first_sequence,
        last_sequence, status, detected_at_ms, retention_anchor_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)` ,
    )
    .run(
      gapId,
      event.producer.instanceId,
      event.producer.bootId,
      first,
      last,
      ingestedAt,
      ingestedAt,
      ingestedAt + ACTIVITY_RETENTION_DAYS.fact * DAY_MS,
    );
}

function advanceProducerContiguous(
  database: Database.Database,
  event: ActivityEventInput,
  ingestedAt: number,
): void {
  const producer = database.prepare(
    `SELECT highest_contiguous_sequence AS contiguous
     FROM producer_instances WHERE producer_instance_id = ? AND producer_boot_id = ?`,
  ).get(event.producer.instanceId, event.producer.bootId) as { contiguous: number };
  const rows = database.prepare(
    `SELECT producer_sequence FROM behavior_facts
     WHERE producer_instance_id = ? AND producer_boot_id = ?
       AND producer_sequence > ?
     ORDER BY producer_sequence`,
  ).all(
    event.producer.instanceId,
    event.producer.bootId,
    producer.contiguous,
  ) as Array<{ producer_sequence: number }>;
  let contiguous = producer.contiguous;
  for (const row of rows) {
    if (row.producer_sequence !== contiguous + 1) break;
    contiguous = row.producer_sequence;
  }
  if (contiguous !== producer.contiguous) {
    database.prepare(
      `UPDATE producer_instances SET highest_contiguous_sequence = ?
       WHERE producer_instance_id = ? AND producer_boot_id = ?`,
    ).run(contiguous, event.producer.instanceId, event.producer.bootId);
  }
  database.prepare(
    `UPDATE source_gaps SET status = 'closed', closed_at_ms = ?
     WHERE producer_instance_id = ? AND producer_boot_id = ?
       AND status = 'open' AND last_sequence <= ?`,
  ).run(ingestedAt, event.producer.instanceId, event.producer.bootId, contiguous);
  database.prepare(
    `UPDATE source_gaps SET first_sequence = ?
     WHERE producer_instance_id = ? AND producer_boot_id = ?
       AND status = 'open' AND first_sequence <= ? AND last_sequence > ?`,
  ).run(
    contiguous + 1,
    event.producer.instanceId,
    event.producer.bootId,
    contiguous,
    contiguous,
  );
}

function insertFact(
  database: Database.Database,
  event: ActivityEventInput,
  fingerprint: string,
  payloadJson: string,
  ingestedAt: number,
  ownedMutationBytes: number,
): number {
  const definition = requireActivityEventDefinition(event.eventName);
  const occurredAt = parseTimestamp(event.occurredAt, "occurred_at");
  const retentionAnchor = Math.min(occurredAt, ingestedAt);
  const expiresAt = retentionAnchor + ACTIVITY_RETENTION_DAYS.fact * DAY_MS;
  const result = database
    .prepare(
      `INSERT INTO behavior_facts (
        event_id, event_name, schema_version, occurred_at_ms, ingested_at_ms,
        ingest_fingerprint_sha256, producer_name, producer_version,
        producer_instance_id, producer_boot_id, producer_boot_started_at_ms,
        producer_sequence, actor_type, actor_agent, runtime_channel, runtime_surface,
        app_version, source_revision, backend_profile_id, cwd, project_id,
        terminal_session_id, panel_id, tmux_pane_id, thread_id, turn_id,
        interaction_id, run_id, operation_id, browser_group_id, tab_id,
        correlation_id, causation_id, parent_event_id, result_status, result_code,
        payload_json, privacy_classification, redaction_version, local_only,
        retention_class, retention_anchor_ms, expires_at_ms, priority,
        owned_mutation_bytes
      ) VALUES (
        @eventId, @eventName, @schemaVersion, @occurredAt, @ingestedAt,
        @fingerprint, @producerName, @producerVersion, @producerInstanceId,
        @producerBootId, @producerBootStartedAt, @producerSequence, @actorType,
        @actorAgent, @runtimeChannel, @runtimeSurface, @appVersion, @sourceRevision,
        @backendProfileId, @cwd, @projectId, @terminalSessionId, @panelId,
        @tmuxPaneId, @threadId, @turnId, @interactionId, @runId, @operationId,
        @browserGroupId, @tabId, @correlationId, @causationId, @parentEventId,
        @resultStatus, @resultCode, @payloadJson, @privacy, @redactionVersion,
        1, 'fact_30d', @retentionAnchor, @expiresAt, @priority, @ownedMutationBytes
      )`,
    )
    .run({
      eventId: event.eventId,
      eventName: event.eventName,
      schemaVersion: event.schemaVersion,
      occurredAt,
      ingestedAt,
      fingerprint,
      producerName: event.producer.name,
      producerVersion: event.producer.version,
      producerInstanceId: event.producer.instanceId,
      producerBootId: event.producer.bootId,
      producerBootStartedAt: parseTimestamp(event.producer.bootStartedAt, "boot_started_at"),
      producerSequence: event.producer.sequence,
      actorType: event.actor.type,
      actorAgent: event.actor.agent ?? null,
      runtimeChannel: event.runtime.channel,
      runtimeSurface: event.runtime.surface,
      appVersion: event.runtime.appVersion ?? null,
      sourceRevision: event.runtime.sourceRevision ?? null,
      backendProfileId: event.runtime.backendProfileId ?? null,
      cwd: event.scope.cwd ?? null,
      projectId: event.scope.projectId ?? null,
      terminalSessionId: event.scope.terminalSessionId ?? null,
      panelId: event.scope.panelId ?? null,
      tmuxPaneId: event.scope.tmuxPaneId ?? null,
      threadId: event.scope.threadId ?? null,
      turnId: event.scope.turnId ?? null,
      interactionId: event.scope.interactionId ?? null,
      runId: event.scope.runId ?? null,
      operationId: event.scope.operationId ?? null,
      browserGroupId: event.scope.browserGroupId ?? null,
      tabId: event.scope.tabId ?? null,
      correlationId: event.correlationId ?? null,
      causationId: event.causationId ?? null,
      parentEventId: event.parentEventId ?? null,
      resultStatus: event.result?.status ?? null,
      resultCode: event.result?.code ?? null,
      payloadJson,
      privacy: definition.privacy,
      redactionVersion: ACTIVITY_REDACTION_VERSION,
      retentionAnchor,
      expiresAt,
      priority: definition.priority,
      ownedMutationBytes,
    });
  return Number(result.lastInsertRowid);
}

function insertOwnedDescriptors(
  database: Database.Database,
  event: ActivityEventInput,
  contentEntries: Array<{ bytes: Buffer; encrypted: ActivityEncryptedValue }>,
  refEntries: ActivityEncryptedValue[],
  ingestedAt: number,
): void {
  const occurredAt = parseTimestamp(event.occurredAt, "occurred_at");
  const retentionAnchor = Math.min(occurredAt, ingestedAt);
  const contentExpiry = retentionAnchor + ACTIVITY_RETENTION_DAYS.content * DAY_MS;
  const factExpiry = retentionAnchor + ACTIVITY_RETENTION_DAYS.fact * DAY_MS;
  event.contents.forEach((content, index) => {
    const { bytes, encrypted } = contentEntries[index]!;
    const digest = sha256(bytes);
    database.prepare(
      `INSERT INTO activity_contents (
        content_id, owner_event_id, owner_role, owner_ordinal, sha256, kind,
        media_type, byte_length, compression, encryption, encryption_key_id,
        encryption_key_version, ciphertext, nonce, auth_tag, created_at_ms,
        retention_anchor_ms, expires_at_ms, redaction_version, current_availability
      ) VALUES (?, ?, ?, ?, ?, 'inline', ?, ?, 'none', 'aes-256-gcm', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')`,
    ).run(
      content.contentId, event.eventId, content.role, index, digest,
      content.mediaType, bytes.byteLength, encrypted.keyId, encrypted.keyVersion,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, ingestedAt,
      retentionAnchor, contentExpiry, ACTIVITY_REDACTION_VERSION,
    );
    database.prepare(
      `INSERT INTO fact_content_links (
        event_id, role, ordinal, content_id, sha256_snapshot,
        byte_length_snapshot, expected_expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.eventId, content.role, index, content.contentId, digest, bytes.byteLength, contentExpiry);
  });
  event.externalRefs.forEach((ref, index) => {
    const encrypted = refEntries[index]!;
    const expectedExpiresAt = ref.expectedExpiresAt
      ? parseTimestamp(ref.expectedExpiresAt, "expected_expires_at")
      : null;
    const refExpiry = expectedExpiresAt === null
      ? factExpiry
      : Math.max(retentionAnchor, Math.min(factExpiry, expectedExpiresAt));
    database.prepare(
      `INSERT INTO external_refs (
        ref_id, owner_event_id, owner_role, owner_ordinal, authority,
        locator_ciphertext, locator_nonce, locator_auth_tag, encryption_key_id,
        encryption_key_version, version_or_digest, captured_at_ms,
        expected_expires_at_ms, retention_anchor_ms, expires_at_ms,
        current_availability
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')`,
    ).run(
      ref.refId, event.eventId, ref.role, index, ref.authority,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyId,
      encrypted.keyVersion, ref.versionOrDigest, parseTimestamp(ref.capturedAt, "captured_at"),
      expectedExpiresAt, retentionAnchor, refExpiry,
    );
    database.prepare(
      `INSERT INTO fact_external_ref_links (
        event_id, role, ordinal, ref_id, availability_at_capture
      ) VALUES (?, ?, ?, ?, 'available')`,
    ).run(event.eventId, ref.role, index, ref.refId);
  });
}

export function recordActivityBatch(
  database: Database.Database,
  events: ActivityEventInput[],
  contentKey: Buffer | null,
  now: () => number,
  maxDatabaseBytes = DEFAULT_MAX_DATABASE_BYTES,
): ActivityWriteAck[] {
  const write = database.transaction(() => {
    const userVersion = database.pragma("user_version", { simple: true }) as number;
    if (Math.floor(userVersion / 1000) !== ACTIVITY_COMPATIBILITY_MAJOR) {
      throw new Error("activity_schema_writer_incompatible");
    }
    return events.map((input): ActivityWriteAck => {
      const { normalized: event, fingerprint } = canonicalizeActivityEvent(input);
      const existing = findExisting(database, event);
      if (existing) {
        if (existing.ingest_fingerprint_sha256 !== fingerprint) {
          throw new Error("activity_idempotency_conflict");
        }
        return { eventId: event.eventId, status: "duplicate", activityOffset: existing.activity_offset };
      }
      if (event.contents.length + event.externalRefs.length > 16) {
        throw new Error("activity_descriptor_limit_exceeded");
      }
      const ingestedAt = now();
      const hasDescriptors = event.contents.length > 0 || event.externalRefs.length > 0;
      let contentEntries = contentKey
        ? event.contents.map((content) => {
            const bytes = redactContent(Buffer.from(content.bytesBase64, "base64"), content.mediaType);
            return { bytes, encrypted: encryptActivityValue(bytes, contentKey) };
          })
        : [];
      let refEntries = contentKey
        ? event.externalRefs.map((ref) =>
            encryptActivityValue(Buffer.from(ref.locator, "utf8"), contentKey),
          )
        : [];
      const payloadJson = JSON.stringify(event.payload);
      let ownedBytes = mutationBytes(
        payloadJson,
        contentEntries.map((entry) => ({ encrypted: entry.encrypted, byteLength: entry.bytes.byteLength })),
        refEntries,
      );
      if (ownedBytes > MAX_OWNED_MUTATION_BYTES) {
        throw new Error("activity_owned_mutation_budget_exceeded");
      }
      const pageCount = database.pragma("page_count", { simple: true }) as number;
      const pageSize = database.pragma("page_size", { simple: true }) as number;
      const keepDescriptors =
        hasDescriptors && contentKey !== null &&
        pageCount * pageSize + ownedBytes <= maxDatabaseBytes;
      if (!keepDescriptors) {
        contentEntries = [];
        refEntries = [];
        ownedBytes = mutationBytes(payloadJson, [], []);
      }
      upsertProducer(database, event, ingestedAt);
      recordGapIfNeeded(database, event, ingestedAt);
      const activityOffset = insertFact(
        database, event, fingerprint, payloadJson, ingestedAt, ownedBytes,
      );
      insertOwnedDescriptors(
        database,
        keepDescriptors ? event : { ...event, contents: [], externalRefs: [] },
        contentEntries,
        refEntries,
        ingestedAt,
      );
      advanceProducerContiguous(database, event, ingestedAt);
      return { eventId: event.eventId, status: "committed", activityOffset };
    });
  });
  return write.immediate();
}
