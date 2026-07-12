import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ActivityEventInput,
  ActivityFactsQuery,
  ActivityOperationScope,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import { migrateActivityDatabase } from "./migrations";
import { recordActivityBatch } from "./database-record";
import {
  queryActivityDataPolicy,
  queryActivityContent,
  queryActivityFacts,
  queryActivitySources,
  queryActivityTimeline,
} from "./database-query";
import {
  createDeleteJob,
  recordActivityAccessAudit,
  readDeleteJob,
  readActivityExportSnapshot,
  readMembershipSnapshot,
  runDeleteBatch,
  runRetentionSweep,
  type ActivityMembershipSnapshot,
} from "./database-maintenance";
import { deriveAuditSubjectHmac, loadActivityContentKey } from "./crypto";
import {
  recordIngestRejection,
  type ActivityIngestRejectionInput,
} from "./database-rejection";

const SQLITE_INITIALIZATION_RETRY_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 25;
const sqliteRetrySignal = new Int32Array(new SharedArrayBuffer(4));

function withSqliteInitializationRetry<T>(operation: () => T): T {
  const deadline = Date.now() + SQLITE_INITIALIZATION_RETRY_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "SQLITE_BUSY" || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(
        sqliteRetrySignal,
        0,
        0,
        SQLITE_INITIALIZATION_RETRY_DELAY_MS,
      );
    }
  }
}

export interface ActivityDatabaseOptions {
  databasePath: string;
  contentKeyBase64: string | null;
  maxDatabaseBytes?: number;
  activityKeyEnvironment?: {
    testMode: boolean;
    testKey: string | null;
  };
}

export class ActivityDatabase {
  private readonly database: Database.Database;
  private readonly contentKey: Buffer | null;

  constructor(private readonly options: ActivityDatabaseOptions) {
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(options.databasePath), 0o700);
    this.database = new Database(options.databasePath);
    this.database.pragma("busy_timeout = 5000");
    withSqliteInitializationRetry(() =>
      this.database.pragma("journal_mode = WAL"),
    );
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("temp_store = MEMORY");
    withSqliteInitializationRetry(() =>
      migrateActivityDatabase(this.database),
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = `${options.databasePath}${suffix}`;
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, 0o600);
      }
    }
    if (options.contentKeyBase64) {
      this.contentKey = Buffer.from(options.contentKeyBase64, "base64");
    } else {
      this.contentKey = withSqliteInitializationRetry(() => {
        this.database.exec("BEGIN EXCLUSIVE");
        try {
          const contentKey = loadActivityContentKey(
            {
              ...process.env,
              RUNWEAVE_ACTIVITY_TEST_MODE: options.activityKeyEnvironment?.testMode
                ? "true"
                : "false",
              ...(options.activityKeyEnvironment?.testKey
                ? { RUNWEAVE_ACTIVITY_TEST_KEY: options.activityKeyEnvironment.testKey }
                : {}),
            },
            path.dirname(options.databasePath),
          );
          this.database.exec("COMMIT");
          return contentKey;
        } catch (error) {
          if (this.database.inTransaction) {
            this.database.exec("ROLLBACK");
          }
          throw error;
        }
      });
    }
  }

  record(events: ActivityEventInput[], nowMs?: number) {
    return recordActivityBatch(
      this.database,
      events,
      this.contentKey,
      () => nowMs ?? Date.now(),
      this.options.maxDatabaseBytes,
    );
  }

  facts(query: ActivityFactsQuery) {
    return queryActivityFacts(this.database, query);
  }

  timeline(selector: ActivityTimelineSelector, query: ActivityFactsQuery) {
    return queryActivityTimeline(this.database, selector, query);
  }

  sources() {
    return queryActivitySources(this.database);
  }

  policy() {
    return queryActivityDataPolicy(this.database, this.options.databasePath);
  }

  content(contentId: string) {
    return queryActivityContent(this.database, contentId, this.contentKey);
  }

  auditSubjectHmac(subject: string): string {
    if (!this.contentKey) throw new Error("activity_content_key_unavailable");
    return deriveAuditSubjectHmac(subject, this.contentKey);
  }

  rejection(input: ActivityIngestRejectionInput): void {
    recordIngestRejection(this.database, input);
  }

  preview(scope: ActivityOperationScope, asOfActivityOffset?: number) {
    return this.database.transaction(() =>
      readMembershipSnapshot(this.database, scope, asOfActivityOffset),
    )();
  }

  exportSnapshot(params: {
    scope: ActivityOperationScope;
    asOfActivityOffset: number;
  }) {
    return readActivityExportSnapshot(this.database, params);
  }

  createDeleteJob(params: {
    requestId: string;
    backendInstanceId: string;
    authSubjectHmac: string;
    scope: ActivityOperationScope;
    snapshot: ActivityMembershipSnapshot;
    nowMs?: number;
  }) {
    return createDeleteJob(this.database, {
      ...params,
      now: params.nowMs ?? Date.now(),
    });
  }

  recordAccessAudit(params: {
    requestId: string;
    backendInstanceId: string;
    authSubjectHmac: string;
    action: "content_read" | "export";
    scopeJson: string;
    resultStatus: "succeeded" | "failed";
    resultCode?: string;
    nowMs?: number;
  }): void {
    recordActivityAccessAudit(this.database, {
      ...params,
      now: params.nowMs ?? Date.now(),
    });
  }

  deleteStatus(deleteJobId: string) {
    return readDeleteJob(this.database, deleteJobId);
  }

  runDelete(ownerId: string, nowMs?: number) {
    return runDeleteBatch(this.database, { ownerId, now: nowMs ?? Date.now() });
  }

  runRetention(ownerId: string, nowMs?: number) {
    return runRetentionSweep(this.database, { ownerId, now: nowMs ?? Date.now() });
  }

  integrity(): boolean {
    const integrity = this.database.pragma("integrity_check", { simple: true });
    const foreignKeys = this.database.pragma("foreign_key_check") as unknown[];
    return integrity === "ok" && foreignKeys.length === 0;
  }

  close(): void {
    this.database.pragma("wal_checkpoint(PASSIVE)");
    this.database.close();
    this.contentKey?.fill(0);
  }
}
