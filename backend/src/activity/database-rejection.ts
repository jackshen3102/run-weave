import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { ACTIVITY_RETENTION_DAYS } from "@runweave/shared/activity";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivityIngestRejectionInput {
  requestSha256: string;
  reasonCode: string;
  producerName?: string;
  producerInstanceId?: string;
  producerBootId?: string;
  eventName?: string;
  schemaVersion?: number;
  nowMs?: number;
}

export function recordIngestRejection(
  database: Database.Database,
  input: ActivityIngestRejectionInput,
): void {
  const now = input.nowMs ?? Date.now();
  database.prepare(
    `INSERT INTO ingest_rejections (
      rejection_id, received_at_ms, expires_at_ms, producer_name,
      producer_instance_id, event_name, schema_version, request_sha256,
      reason_code, sanitized_error_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    now,
    now + ACTIVITY_RETENTION_DAYS.fact * DAY_MS,
    input.producerName ?? null,
    input.producerInstanceId ?? null,
    input.eventName ?? null,
    input.schemaVersion ?? null,
    input.requestSha256,
    input.reasonCode.slice(0, 256),
    JSON.stringify({ reasonCode: input.reasonCode.slice(0, 256) }),
  );
  if (input.producerInstanceId && input.producerBootId) {
    database.prepare(
      `UPDATE producer_instances SET last_error_code = ?
       WHERE producer_instance_id = ? AND producer_boot_id = ?`,
    ).run(
      input.reasonCode.slice(0, 256),
      input.producerInstanceId,
      input.producerBootId,
    );
  }
}
