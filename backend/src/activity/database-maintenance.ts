import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ActivityDeleteJobDto,
  ActivityFactDto,
  ActivityOperationScope,
} from "@runweave/shared/activity";
import { ACTIVITY_RETENTION_DAYS } from "@runweave/shared/activity";
import { canonicalActivityScope, canonicalJson, sha256 } from "./canonical";
import { queryActivityFacts } from "./database-query";

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_BATCH_ROWS = 1000;
const DELETE_BATCH_BYTES = 8 * 1024 * 1024;

interface Lease {
  owner_backend_instance_id: string;
  fencing_token: number;
  expires_at_ms: number;
}

export interface ActivityMembershipSnapshot {
  scope: ActivityOperationScope;
  asOfActivityOffset: number;
  factCount: number;
  contentCount: number;
  externalRefCount: number;
  estimatedExportBytes: number;
  membershipDigestVersion: 1;
  membershipDigest: string;
  countDigest: string;
}

export function recordActivityAccessAudit(
  database: Database.Database,
  params: {
    requestId: string;
    backendInstanceId: string;
    authSubjectHmac: string;
    action: "content_read" | "export";
    scopeJson: string;
    resultStatus: "succeeded" | "failed";
    resultCode?: string;
    now: number;
  },
): void {
  const replay = database.prepare(
    "SELECT 1 FROM activity_access_audit WHERE request_id = ?",
  ).get(params.requestId);
  if (replay) throw new Error("activity_request_replayed");
  database
    .prepare(
      `INSERT INTO activity_access_audit (
        request_id, occurred_at_ms, backend_instance_id,
        auth_subject_hmac_sha256, auth_hmac_key_version, action,
        scope_json, result_status, result_code, expires_at_ms
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.requestId,
      params.now,
      params.backendInstanceId,
      params.authSubjectHmac,
      params.action,
      params.scopeJson,
      params.resultStatus,
      params.resultCode ?? null,
      params.now + ACTIVITY_RETENTION_DAYS.fact * DAY_MS,
    );
}

function scopeSql(scope: ActivityOperationScope, alias = "fact"): {
  clause: string;
  value: string;
} {
  return typeof scope.projectId === "string"
    ? { clause: `${alias}.project_id = ?`, value: scope.projectId }
    : { clause: `${alias}.thread_id = ?`, value: scope.threadId as string };
}

export function readMembershipSnapshot(
  database: Database.Database,
  scope: ActivityOperationScope,
  asOfActivityOffset?: number,
): ActivityMembershipSnapshot {
  const { clause, value } = scopeSql(scope);
  const cutoff =
    asOfActivityOffset ??
    Number(
      (database.prepare("SELECT COALESCE(MAX(activity_offset), 0) AS value FROM behavior_facts").get() as { value: number }).value,
    );
  const facts = database.prepare(
    `SELECT event_id, ingest_fingerprint_sha256, owned_mutation_bytes
     FROM behavior_facts fact
     WHERE ${clause} AND fact.activity_offset <= ? ORDER BY fact.event_id`,
  ).all(value, cutoff) as Array<{
    event_id: string;
    ingest_fingerprint_sha256: string;
    owned_mutation_bytes: number;
  }>;
  const members: Array<Record<string, string | number>> = [];
  let contentCount = 0;
  let externalRefCount = 0;
  for (const fact of facts) {
    members.push({ kind: "fact", objectId: fact.event_id, fingerprint: fact.ingest_fingerprint_sha256 });
    const contents = database.prepare(
      `SELECT link.role, link.ordinal, link.content_id, link.sha256_snapshot,
        content.current_availability
       FROM fact_content_links link JOIN activity_contents content
         ON content.content_id = link.content_id
       WHERE link.event_id = ? ORDER BY link.role, link.ordinal, link.content_id`,
    ).all(fact.event_id) as Array<{
      role: string;
      ordinal: number;
      content_id: string;
      sha256_snapshot: string;
      current_availability: string;
    }>;
    contentCount += contents.length;
    members.push(...contents.map((entry) => ({
      kind: "content", role: entry.role, ordinal: entry.ordinal,
      objectId: entry.content_id, digest: entry.sha256_snapshot,
      availability: entry.current_availability,
    })));
    const refs = database.prepare(
      `SELECT link.role, link.ordinal, link.ref_id, ref.version_or_digest,
        ref.current_availability
       FROM fact_external_ref_links link JOIN external_refs ref ON ref.ref_id = link.ref_id
       WHERE link.event_id = ? ORDER BY link.role, link.ordinal, link.ref_id`,
    ).all(fact.event_id) as Array<{
      role: string;
      ordinal: number;
      ref_id: string;
      version_or_digest: string;
      current_availability: string;
    }>;
    externalRefCount += refs.length;
    members.push(...refs.map((entry) => ({
      kind: "ref", role: entry.role, ordinal: entry.ordinal,
      objectId: entry.ref_id, digest: entry.version_or_digest,
      availability: entry.current_availability,
    })));
  }
  members.sort((left, right) =>
    `${left.objectId}:${left.kind}:${left.role ?? ""}:${left.ordinal ?? 0}`.localeCompare(
      `${right.objectId}:${right.kind}:${right.role ?? ""}:${right.ordinal ?? 0}`,
    ),
  );
  const counts = {
    factCount: facts.length,
    contentCount,
    externalRefCount,
  };
  return {
    scope,
    asOfActivityOffset: cutoff,
    ...counts,
    estimatedExportBytes: facts.reduce((total, fact) => total + fact.owned_mutation_bytes, 0),
    membershipDigestVersion: 1,
    membershipDigest: sha256(canonicalJson({ version: 1, scope, counts, members })),
    countDigest: sha256(canonicalJson(counts)),
  };
}

export function readActivityExportSnapshot(
  database: Database.Database,
  params: {
    scope: ActivityOperationScope;
    asOfActivityOffset: number;
  },
): ActivityFactDto[] {
  return database.transaction(() => {
    const facts: ActivityFactDto[] = [];
    let cursor: string | undefined;
    do {
      const page = queryActivityFacts(database, {
        ...(params.scope.projectId ? { projectId: params.scope.projectId } : {}),
        ...(params.scope.threadId ? { threadId: params.scope.threadId } : {}),
        asOfActivityOffset: params.asOfActivityOffset,
        cursor,
        limit: 200,
      });
      facts.push(...page.facts);
      cursor = page.nextCursor;
    } while (cursor);
    return facts;
  })();
}

export function acquireMaintenanceLease(
  database: Database.Database,
  leaseName: string,
  ownerId: string,
  now: number,
  ttlMs: number,
): Lease | null {
  return database.transaction(() => {
    const current = database.prepare(
      "SELECT * FROM maintenance_leases WHERE lease_name = ?",
    ).get(leaseName) as Lease | undefined;
    if (current && current.expires_at_ms > now && current.owner_backend_instance_id !== ownerId) {
      return null;
    }
    const nextToken = (current?.fencing_token ?? 0) +
      (current?.owner_backend_instance_id === ownerId && current.expires_at_ms > now ? 0 : 1);
    database.prepare(
      `INSERT INTO maintenance_leases (
        lease_name, owner_backend_instance_id, fencing_token, acquired_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lease_name) DO UPDATE SET
        owner_backend_instance_id = excluded.owner_backend_instance_id,
        fencing_token = excluded.fencing_token,
        acquired_at_ms = excluded.acquired_at_ms,
        expires_at_ms = excluded.expires_at_ms`,
    ).run(leaseName, ownerId, nextToken, now, now + ttlMs);
    return {
      owner_backend_instance_id: ownerId,
      fencing_token: nextToken,
      expires_at_ms: now + ttlMs,
    };
  })();
}

function assertLease(
  database: Database.Database,
  leaseName: string,
  ownerId: string,
  token: number,
  now: number,
): void {
  const lease = database.prepare(
    `SELECT owner_backend_instance_id, fencing_token, expires_at_ms
     FROM maintenance_leases WHERE lease_name = ?`,
  ).get(leaseName) as Lease | undefined;
  if (
    !lease || lease.owner_backend_instance_id !== ownerId ||
    lease.fencing_token !== token || lease.expires_at_ms <= now
  ) {
    throw new Error("activity_maintenance_lease_lost");
  }
}

export function createDeleteJob(
  database: Database.Database,
  params: {
    requestId: string;
    backendInstanceId: string;
    authSubjectHmac: string;
    scope: ActivityOperationScope;
    snapshot: ActivityMembershipSnapshot;
    now: number;
  },
): ActivityDeleteJobDto {
  const canonicalScope = canonicalActivityScope(params.scope);
  const deleteJobId = crypto.randomUUID();
  database.transaction(() => {
    const replay = database.prepare(
      `SELECT 1 FROM activity_delete_jobs WHERE request_id = ?
       UNION ALL SELECT 1 FROM activity_access_audit WHERE request_id = ? LIMIT 1`,
    ).get(params.requestId, params.requestId);
    if (replay) throw new Error("activity_request_replayed");
    const activeJob = database.prepare(
      "SELECT 1 FROM activity_delete_jobs WHERE status IN ('pending', 'running', 'blocked') LIMIT 1",
    ).get();
    if (activeJob) throw new Error("activity_delete_in_progress");
    database.prepare(
      `INSERT INTO activity_delete_jobs (
        delete_job_id, request_id, auth_subject_hmac_sha256,
        auth_hmac_key_version, scope_type, scope_id, as_of_activity_offset,
        membership_digest_version, preview_membership_sha256,
        preview_count_sha256, preview_fact_count, status,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      deleteJobId, params.requestId, params.authSubjectHmac,
      canonicalScope.scopeType, canonicalScope.scopeId,
      params.snapshot.asOfActivityOffset, params.snapshot.membershipDigest,
      params.snapshot.countDigest, params.snapshot.factCount, params.now, params.now,
    );
    database.prepare(
      `INSERT INTO activity_access_audit (
        request_id, occurred_at_ms, backend_instance_id,
        auth_subject_hmac_sha256, auth_hmac_key_version, action,
        scope_json, result_status, expires_at_ms
      ) VALUES (?, ?, ?, ?, 1, 'delete_requested', ?, 'succeeded', ?)`,
    ).run(
      params.requestId, params.now, params.backendInstanceId,
      params.authSubjectHmac, canonicalScope.canonicalJson,
      params.now + ACTIVITY_RETENTION_DAYS.fact * DAY_MS,
    );
  })();
  return {
    deleteJobId,
    scope: params.scope,
    asOfActivityOffset: params.snapshot.asOfActivityOffset,
    status: "pending",
    previewFactCount: params.snapshot.factCount,
    deletedFactCount: 0,
    createdAt: new Date(params.now).toISOString(),
    updatedAt: new Date(params.now).toISOString(),
  };
}

interface DeleteJobRow {
  delete_job_id: string;
  request_id: string;
  auth_subject_hmac_sha256: string;
  scope_type: "project" | "thread";
  scope_id: string;
  as_of_activity_offset: number;
  status: ActivityDeleteJobDto["status"];
  preview_fact_count: number;
  deleted_fact_count: number;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  last_error_code: string | null;
  last_deleted_activity_offset: number;
}

function rowToDeleteJob(row: DeleteJobRow): ActivityDeleteJobDto {
  return {
    deleteJobId: row.delete_job_id,
    scope: row.scope_type === "project" ? { projectId: row.scope_id } : { threadId: row.scope_id },
    asOfActivityOffset: row.as_of_activity_offset,
    status: row.status,
    previewFactCount: row.preview_fact_count,
    deletedFactCount: row.deleted_fact_count,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
    ...(row.completed_at_ms ? { completedAt: new Date(row.completed_at_ms).toISOString() } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
  };
}

export function readDeleteJob(
  database: Database.Database,
  deleteJobId: string,
): ActivityDeleteJobDto | null {
  const row = database.prepare(
    "SELECT * FROM activity_delete_jobs WHERE delete_job_id = ?",
  ).get(deleteJobId) as DeleteJobRow | undefined;
  return row ? rowToDeleteJob(row) : null;
}

export function runDeleteBatch(
  database: Database.Database,
  params: { ownerId: string; now: number; leaseTtlMs?: number },
): ActivityDeleteJobDto | null {
  const lease = acquireMaintenanceLease(
    database, "activity-delete", params.ownerId, params.now, params.leaseTtlMs ?? 10_000,
  );
  if (!lease) {
    return null;
  }
  try {
    return database.transaction(() => {
    assertLease(database, "activity-delete", params.ownerId, lease.fencing_token, params.now);
    const job = database.prepare(
      `SELECT * FROM activity_delete_jobs
       WHERE status IN ('pending', 'running', 'blocked')
       ORDER BY created_at_ms LIMIT 1`,
    ).get() as DeleteJobRow | undefined;
    if (!job) {
      return null;
    }
    if (job.status === "blocked") {
      database.prepare(
        `UPDATE activity_delete_jobs SET status = 'running', updated_at_ms = ?,
          last_error_code = NULL WHERE delete_job_id = ?`,
      ).run(params.now, job.delete_job_id);
    }
    const column = job.scope_type === "project" ? "project_id" : "thread_id";
    const candidates = database.prepare(
      `SELECT activity_offset, owned_mutation_bytes FROM behavior_facts
       WHERE ${column} = ? AND activity_offset > ? AND activity_offset <= ?
       ORDER BY activity_offset LIMIT ?`,
    ).all(
      job.scope_id, job.last_deleted_activity_offset,
      job.as_of_activity_offset, DELETE_BATCH_ROWS,
    ) as Array<{ activity_offset: number; owned_mutation_bytes: number }>;
    let bytes = 0;
    const selected: typeof candidates = [];
    for (const candidate of candidates) {
      if (
        selected.length > 0 &&
        bytes + candidate.owned_mutation_bytes > DELETE_BATCH_BYTES
      ) {
        break;
      }
      selected.push(candidate);
      bytes += candidate.owned_mutation_bytes;
    }
    if (selected.length === 0) {
      const completedAt = params.now;
      database.prepare(
        `UPDATE activity_delete_jobs SET status = 'completed', updated_at_ms = ?,
          completed_at_ms = ?, expires_at_ms = ? WHERE delete_job_id = ?`,
      ).run(completedAt, completedAt, completedAt + 30 * DAY_MS, job.delete_job_id);
      const completionRequestId = sha256(`${job.request_id}:completed`);
      database.prepare(
        `INSERT OR IGNORE INTO activity_access_audit (
          request_id, occurred_at_ms, backend_instance_id, auth_subject_hmac_sha256,
          auth_hmac_key_version, action, scope_json, result_status, expires_at_ms
        ) VALUES (?, ?, ?, ?, 1, 'delete_completed', ?, 'succeeded', ?)`,
      ).run(
        completionRequestId, completedAt, params.ownerId,
        job.auth_subject_hmac_sha256,
        JSON.stringify(job.scope_type === "project" ? { projectId: job.scope_id } : { threadId: job.scope_id }),
        completedAt + 30 * DAY_MS,
      );
    } else {
      const offsets = selected.map((candidate) => candidate.activity_offset);
      const placeholders = offsets.map(() => "?").join(",");
      database.prepare(`DELETE FROM behavior_facts WHERE activity_offset IN (${placeholders})`).run(...offsets);
      database.prepare(
        `UPDATE activity_delete_jobs SET status = 'running',
          last_deleted_activity_offset = ?, deleted_fact_count = deleted_fact_count + ?,
          updated_at_ms = ?, last_error_code = NULL WHERE delete_job_id = ?`,
      ).run(offsets.at(-1), offsets.length, params.now, job.delete_job_id);
    }
    return readDeleteJob(database, job.delete_job_id);
    })();
  } catch (error) {
    const currentLease = database.prepare(
      `SELECT owner_backend_instance_id, fencing_token, expires_at_ms
       FROM maintenance_leases WHERE lease_name = 'activity-delete'`,
    ).get() as Lease | undefined;
    if (
      currentLease?.owner_backend_instance_id === params.ownerId &&
      currentLease.fencing_token === lease.fencing_token &&
      currentLease.expires_at_ms > params.now
    ) {
      const errorCode =
        error && typeof error === "object" && "code" in error &&
        typeof error.code === "string" && error.code.startsWith("SQLITE_")
          ? error.code
          : "activity_delete_batch_failed";
      database.prepare(
        `UPDATE activity_delete_jobs SET status = 'blocked', updated_at_ms = ?,
          last_error_code = ? WHERE status IN ('pending', 'running')`,
      ).run(params.now, errorCode);
    }
    throw error;
  }
}

export function runRetentionSweep(
  database: Database.Database,
  params: { ownerId: string; now: number; leaseTtlMs?: number },
): number {
  const lease = acquireMaintenanceLease(
    database, "retention", params.ownerId, params.now, params.leaseTtlMs ?? 10_000,
  );
  if (!lease) {
    return 0;
  }
  return database.transaction(() => {
    assertLease(database, "retention", params.ownerId, lease.fencing_token, params.now);
    database.prepare(
      `UPDATE activity_contents SET ciphertext = NULL, nonce = NULL, auth_tag = NULL,
        current_availability = 'expired', deleted_at_ms = ?
       WHERE content_id IN (
         SELECT content_id FROM activity_contents
         WHERE current_availability = 'available' AND expires_at_ms <= ? LIMIT 1000
       )`,
    ).run(params.now, params.now);
    database.prepare(
      `UPDATE external_refs SET locator_ciphertext = NULL, locator_nonce = NULL,
        locator_auth_tag = NULL, current_availability = 'expired', deleted_at_ms = ?
       WHERE ref_id IN (
         SELECT ref_id FROM external_refs
         WHERE current_availability IN ('available', 'missing') AND expires_at_ms <= ? LIMIT 1000
       )`,
    ).run(params.now, params.now);
    const deletedFacts = database.prepare(
      `DELETE FROM behavior_facts WHERE activity_offset IN (
        SELECT activity_offset FROM behavior_facts WHERE expires_at_ms <= ? LIMIT 1000
      )`,
    ).run(params.now).changes;
    for (const table of ["source_gaps", "ingest_rejections", "activity_access_audit"] as const) {
      database.prepare(
        `DELETE FROM ${table} WHERE rowid IN (
          SELECT rowid FROM ${table} WHERE expires_at_ms <= ? LIMIT 1000
        )`,
      ).run(params.now);
    }
    database.prepare(
      `DELETE FROM activity_delete_jobs WHERE delete_job_id IN (
        SELECT job.delete_job_id FROM activity_delete_jobs job
        WHERE job.status = 'completed' AND job.expires_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1 FROM behavior_facts fact
            WHERE fact.activity_offset <= job.as_of_activity_offset
              AND ((job.scope_type = 'project' AND fact.project_id = job.scope_id)
                OR (job.scope_type = 'thread' AND fact.thread_id = job.scope_id))
          ) LIMIT 1000
      )`,
    ).run(params.now);
    database.prepare(
      `DELETE FROM producer_instances WHERE rowid IN (
        SELECT producer.rowid FROM producer_instances producer
        WHERE producer.expires_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1 FROM behavior_facts fact
            WHERE fact.producer_instance_id = producer.producer_instance_id
              AND fact.producer_boot_id = producer.producer_boot_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM source_gaps gap
            WHERE gap.producer_instance_id = producer.producer_instance_id
              AND gap.producer_boot_id = producer.producer_boot_id
          ) LIMIT 1000
      )`,
    ).run(params.now);
    database.prepare(
      `INSERT INTO retention_sweeps (
        data_class, last_started_at_ms, last_completed_at_ms, last_deleted_count
      ) VALUES ('default', ?, ?, ?)
      ON CONFLICT(data_class) DO UPDATE SET
        last_started_at_ms = excluded.last_started_at_ms,
        last_completed_at_ms = excluded.last_completed_at_ms,
        last_deleted_count = excluded.last_deleted_count,
        last_error_code = NULL`,
    ).run(params.now, params.now, deletedFacts);
    return deletedFacts;
  })();
}
