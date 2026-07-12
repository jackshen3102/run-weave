import type Database from "better-sqlite3";

export const ACTIVITY_COMPATIBILITY_MAJOR = 1;
export const ACTIVITY_ADDITIVE_MINOR = 0;
export const ACTIVITY_USER_VERSION =
  ACTIVITY_COMPATIBILITY_MAJOR * 1000 + ACTIVITY_ADDITIVE_MINOR;

const SCHEMA_SQL = `
CREATE TABLE producer_instances (
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  producer_name TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  runtime_channel TEXT NOT NULL,
  runtime_surface TEXT NOT NULL,
  boot_started_at_ms INTEGER NOT NULL,
  started_event_id TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  highest_seen_sequence INTEGER NOT NULL,
  highest_contiguous_sequence INTEGER NOT NULL,
  last_commit_latency_ms INTEGER,
  last_error_code TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK (highest_contiguous_sequence BETWEEN 0 AND highest_seen_sequence),
  PRIMARY KEY (producer_instance_id, producer_boot_id)
) STRICT;
CREATE INDEX producer_instances_expiry_idx
  ON producer_instances (expires_at_ms, producer_instance_id, producer_boot_id);

CREATE TABLE behavior_facts (
  activity_offset INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  ingest_fingerprint_sha256 TEXT NOT NULL,
  producer_name TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  producer_boot_started_at_ms INTEGER NOT NULL,
  producer_sequence INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_agent TEXT,
  runtime_channel TEXT NOT NULL,
  runtime_surface TEXT NOT NULL,
  app_version TEXT,
  source_revision TEXT,
  backend_profile_id TEXT,
  cwd TEXT,
  project_id TEXT,
  terminal_session_id TEXT,
  panel_id TEXT,
  tmux_pane_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  interaction_id TEXT,
  run_id TEXT,
  operation_id TEXT,
  browser_group_id TEXT,
  tab_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  parent_event_id TEXT,
  result_status TEXT,
  result_code TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  privacy_classification TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  local_only INTEGER NOT NULL CHECK (local_only IN (0, 1)),
  retention_class TEXT NOT NULL,
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  priority TEXT NOT NULL,
  owned_mutation_bytes INTEGER NOT NULL,
  CHECK (schema_version >= 1),
  CHECK (producer_sequence >= 1),
  CHECK (length(ingest_fingerprint_sha256) = 64),
  CHECK (retention_anchor_ms <= occurred_at_ms),
  CHECK (retention_anchor_ms <= ingested_at_ms),
  CHECK (expires_at_ms >= retention_anchor_ms),
  CHECK (owned_mutation_bytes BETWEEN 0 AND 8388608),
  UNIQUE (producer_instance_id, producer_boot_id, producer_sequence),
  FOREIGN KEY (producer_instance_id, producer_boot_id)
    REFERENCES producer_instances(producer_instance_id, producer_boot_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER behavior_facts_immutable_update
  BEFORE UPDATE ON behavior_facts BEGIN
  SELECT RAISE(ABORT, 'behavior_facts_immutable');
END;
CREATE INDEX facts_timeline_idx
  ON behavior_facts (occurred_at_ms, activity_offset);
CREATE INDEX facts_interaction_idx
  ON behavior_facts (interaction_id, occurred_at_ms, activity_offset)
  WHERE interaction_id IS NOT NULL;
CREATE INDEX facts_correlation_idx
  ON behavior_facts (correlation_id, occurred_at_ms, activity_offset)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX facts_thread_idx
  ON behavior_facts (thread_id, occurred_at_ms, activity_offset)
  WHERE thread_id IS NOT NULL;
CREATE INDEX facts_thread_delete_cursor_idx
  ON behavior_facts (thread_id, activity_offset)
  WHERE thread_id IS NOT NULL;
CREATE INDEX facts_run_idx
  ON behavior_facts (run_id, occurred_at_ms, activity_offset)
  WHERE run_id IS NOT NULL;
CREATE INDEX facts_terminal_idx
  ON behavior_facts (terminal_session_id, occurred_at_ms, activity_offset)
  WHERE terminal_session_id IS NOT NULL;
CREATE INDEX facts_project_idx
  ON behavior_facts (project_id, occurred_at_ms, activity_offset)
  WHERE project_id IS NOT NULL;
CREATE INDEX facts_project_delete_cursor_idx
  ON behavior_facts (project_id, activity_offset)
  WHERE project_id IS NOT NULL;
CREATE INDEX facts_runtime_surface_idx
  ON behavior_facts (runtime_channel, runtime_surface, occurred_at_ms, activity_offset);
CREATE INDEX facts_event_idx
  ON behavior_facts (event_name, occurred_at_ms, activity_offset);
CREATE INDEX facts_expiry_idx
  ON behavior_facts (expires_at_ms, activity_offset);

CREATE TABLE activity_contents (
  content_id TEXT PRIMARY KEY,
  owner_event_id TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  owner_ordinal INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  compression TEXT NOT NULL,
  encryption TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  auth_tag BLOB,
  created_at_ms INTEGER NOT NULL,
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  redaction_version TEXT NOT NULL,
  current_availability TEXT NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (owner_ordinal >= 0),
  CHECK (current_availability IN ('available', 'expired', 'deleted')),
  CHECK ((current_availability = 'available' AND deleted_at_ms IS NULL
    AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
    OR (current_availability != 'available' AND deleted_at_ms IS NOT NULL
    AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)),
  UNIQUE (owner_event_id, owner_role, owner_ordinal),
  UNIQUE (content_id, owner_event_id, owner_role, owner_ordinal),
  FOREIGN KEY (owner_event_id) REFERENCES behavior_facts(event_id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER activity_contents_owner_immutable
  BEFORE UPDATE OF owner_event_id, owner_role, owner_ordinal ON activity_contents BEGIN
  SELECT RAISE(ABORT, 'activity_content_owner_immutable');
END;
CREATE INDEX contents_expiry_idx
  ON activity_contents (current_availability, expires_at_ms, content_id);

CREATE TABLE fact_content_links (
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content_id TEXT NOT NULL UNIQUE,
  sha256_snapshot TEXT NOT NULL,
  byte_length_snapshot INTEGER NOT NULL,
  expected_expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event_id, role, ordinal),
  FOREIGN KEY (event_id) REFERENCES behavior_facts(event_id) ON DELETE CASCADE,
  FOREIGN KEY (content_id, event_id, role, ordinal)
    REFERENCES activity_contents(content_id, owner_event_id, owner_role, owner_ordinal)
    ON DELETE CASCADE
) STRICT;
CREATE INDEX fact_content_reverse_idx ON fact_content_links (content_id, event_id);

CREATE TABLE external_refs (
  ref_id TEXT PRIMARY KEY,
  owner_event_id TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  owner_ordinal INTEGER NOT NULL,
  authority TEXT NOT NULL,
  locator_ciphertext BLOB,
  locator_nonce BLOB,
  locator_auth_tag BLOB,
  encryption_key_id TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  version_or_digest TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  expected_expires_at_ms INTEGER,
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  current_availability TEXT NOT NULL,
  last_checked_at_ms INTEGER,
  deleted_at_ms INTEGER,
  CHECK (owner_ordinal >= 0),
  CHECK (current_availability IN ('available', 'expired', 'missing', 'deleted')),
  CHECK ((current_availability IN ('available', 'missing') AND deleted_at_ms IS NULL
    AND locator_ciphertext IS NOT NULL AND locator_nonce IS NOT NULL AND locator_auth_tag IS NOT NULL)
    OR (current_availability IN ('expired', 'deleted') AND deleted_at_ms IS NOT NULL
    AND locator_ciphertext IS NULL AND locator_nonce IS NULL AND locator_auth_tag IS NULL)),
  UNIQUE (owner_event_id, owner_role, owner_ordinal),
  UNIQUE (ref_id, owner_event_id, owner_role, owner_ordinal),
  FOREIGN KEY (owner_event_id) REFERENCES behavior_facts(event_id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER external_refs_owner_immutable
  BEFORE UPDATE OF owner_event_id, owner_role, owner_ordinal ON external_refs BEGIN
  SELECT RAISE(ABORT, 'external_ref_owner_immutable');
END;
CREATE INDEX external_refs_expiry_idx ON external_refs (expires_at_ms, ref_id);

CREATE TABLE fact_external_ref_links (
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ref_id TEXT NOT NULL UNIQUE,
  availability_at_capture TEXT NOT NULL,
  CHECK (availability_at_capture IN ('available', 'missing')),
  PRIMARY KEY (event_id, role, ordinal),
  FOREIGN KEY (event_id) REFERENCES behavior_facts(event_id) ON DELETE CASCADE,
  FOREIGN KEY (ref_id, event_id, role, ordinal)
    REFERENCES external_refs(ref_id, owner_event_id, owner_role, owner_ordinal)
    ON DELETE CASCADE
) STRICT;
CREATE INDEX fact_external_ref_reverse_idx
  ON fact_external_ref_links (ref_id, event_id);

CREATE TABLE source_gaps (
  gap_id TEXT PRIMARY KEY,
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  detected_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  reason_code TEXT,
  source_event_id TEXT,
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (first_sequence >= 1 AND last_sequence >= first_sequence),
  CHECK (status IN ('open', 'closed')),
  FOREIGN KEY (producer_instance_id, producer_boot_id)
    REFERENCES producer_instances(producer_instance_id, producer_boot_id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES behavior_facts(event_id) ON DELETE SET NULL
) STRICT;
CREATE INDEX source_gaps_expiry_idx ON source_gaps (expires_at_ms, gap_id);
CREATE INDEX source_gaps_producer_idx
  ON source_gaps (producer_instance_id, producer_boot_id, gap_id);

CREATE TABLE ingest_rejections (
  rejection_id TEXT PRIMARY KEY,
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  producer_name TEXT,
  producer_instance_id TEXT,
  event_name TEXT,
  schema_version INTEGER,
  request_sha256 TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  sanitized_error_json TEXT NOT NULL CHECK (json_valid(sanitized_error_json))
) STRICT;
CREATE INDEX ingest_rejections_expiry_idx
  ON ingest_rejections (expires_at_ms, rejection_id);

CREATE TABLE retention_sweeps (
  data_class TEXT PRIMARY KEY,
  last_started_at_ms INTEGER,
  last_completed_at_ms INTEGER,
  last_deleted_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
) STRICT;

CREATE TABLE maintenance_leases (
  lease_name TEXT PRIMARY KEY,
  owner_backend_instance_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (fencing_token >= 1),
  CHECK (expires_at_ms > acquired_at_ms)
) STRICT;

CREATE TABLE activity_delete_jobs (
  delete_job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  auth_subject_hmac_sha256 TEXT NOT NULL,
  auth_hmac_key_version INTEGER NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  as_of_activity_offset INTEGER NOT NULL,
  membership_digest_version INTEGER NOT NULL,
  preview_membership_sha256 TEXT NOT NULL,
  preview_count_sha256 TEXT NOT NULL,
  preview_fact_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_deleted_activity_offset INTEGER NOT NULL DEFAULT 0,
  deleted_fact_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  expires_at_ms INTEGER,
  last_error_code TEXT,
  CHECK (scope_type IN ('project', 'thread')),
  CHECK (status IN ('pending', 'running', 'blocked', 'completed')),
  CHECK ((status = 'completed' AND completed_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL)
    OR (status != 'completed' AND completed_at_ms IS NULL AND expires_at_ms IS NULL))
) STRICT;
CREATE TRIGGER activity_delete_jobs_request_immutable
  BEFORE UPDATE OF delete_job_id, request_id, auth_subject_hmac_sha256,
    auth_hmac_key_version, scope_type, scope_id, as_of_activity_offset,
    membership_digest_version, preview_membership_sha256, preview_count_sha256,
    preview_fact_count, created_at_ms ON activity_delete_jobs BEGIN
  SELECT RAISE(ABORT, 'activity_delete_job_request_immutable');
END;
CREATE TRIGGER activity_delete_jobs_progress_monotonic
  BEFORE UPDATE OF status, last_deleted_activity_offset, deleted_fact_count,
    updated_at_ms, completed_at_ms, expires_at_ms ON activity_delete_jobs
  WHEN NEW.last_deleted_activity_offset < OLD.last_deleted_activity_offset
    OR NEW.deleted_fact_count < OLD.deleted_fact_count
    OR NEW.updated_at_ms < OLD.updated_at_ms
    OR OLD.status = 'completed'
    OR (OLD.status = 'running' AND NEW.status = 'pending')
    OR (OLD.status = 'blocked' AND NEW.status = 'pending')
  BEGIN
    SELECT RAISE(ABORT, 'activity_delete_job_progress_not_monotonic');
  END;
CREATE INDEX activity_delete_jobs_status_idx
  ON activity_delete_jobs (status, updated_at_ms, delete_job_id);
CREATE INDEX activity_delete_jobs_scope_idx
  ON activity_delete_jobs (scope_type, scope_id, status, as_of_activity_offset);
CREATE UNIQUE INDEX activity_delete_jobs_single_active_idx
  ON activity_delete_jobs ((1)) WHERE status IN ('pending', 'running', 'blocked');
CREATE INDEX activity_delete_jobs_expiry_idx
  ON activity_delete_jobs (expires_at_ms, delete_job_id) WHERE expires_at_ms IS NOT NULL;

CREATE TABLE activity_access_audit (
  audit_offset INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL,
  backend_instance_id TEXT NOT NULL,
  auth_subject_hmac_sha256 TEXT NOT NULL,
  auth_hmac_key_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  result_status TEXT NOT NULL,
  result_code TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK (action IN ('content_read', 'export', 'delete_requested', 'delete_completed')),
  CHECK (result_status IN ('succeeded', 'failed'))
) STRICT;
CREATE INDEX activity_access_audit_expiry_idx
  ON activity_access_audit (expires_at_ms, audit_offset);
`;

function readUserVersion(database: Database.Database): number {
  return database.pragma("user_version", { simple: true }) as number;
}

export function migrateActivityDatabase(database: Database.Database): void {
  const currentVersion = readUserVersion(database);
  const currentMajor = Math.floor(currentVersion / 1000);
  if (currentMajor > ACTIVITY_COMPATIBILITY_MAJOR) {
    throw new Error("activity_schema_too_new");
  }
  if (currentMajor !== 0 && currentMajor < ACTIVITY_COMPATIBILITY_MAJOR) {
    throw new Error("activity_schema_major_migration_required");
  }
  if (
    currentMajor === ACTIVITY_COMPATIBILITY_MAJOR &&
    currentVersion >= ACTIVITY_USER_VERSION
  ) {
    return;
  }

  database.exec("BEGIN EXCLUSIVE");
  try {
    const lockedVersion = readUserVersion(database);
    const lockedMajor = Math.floor(lockedVersion / 1000);
    if (lockedMajor > ACTIVITY_COMPATIBILITY_MAJOR) {
      throw new Error("activity_schema_too_new");
    }
    if (
      lockedMajor === ACTIVITY_COMPATIBILITY_MAJOR &&
      lockedVersion >= ACTIVITY_USER_VERSION
    ) {
      database.exec("COMMIT");
      return;
    }
    if (lockedVersion === 0) {
      database.exec(SCHEMA_SQL);
    }
    database.pragma(`user_version = ${ACTIVITY_USER_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
