import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  ActivityDataPolicyDto,
  ActivityContentValueDto,
  ActivityDeleteJobDto,
  ActivityEventInput,
  ActivityFactsPage,
  ActivityFactsQuery,
  ActivityOperationScope,
  ActivitySourceDto,
  ActivityTimelineSelector,
  ActivityWriteAck,
} from "@runweave/shared/activity";
import type { ActivityMembershipSnapshot } from "./database-maintenance";
import type { ActivityIngestRejectionInput } from "./database-rejection";
import type { ActivityDatabaseOptions } from "./activity-database";
import type {
  ActivityWorkerCommand,
  ActivityWorkerResponse,
  ActivityWorkerResult,
} from "./worker-protocol";

interface PendingRequest {
  resolve: (value: ActivityWorkerResult) => void;
  reject: (error: Error) => void;
}

function resolveWorkerEntry(env: NodeJS.ProcessEnv): URL {
  const configured = env.RUNWEAVE_ACTIVITY_WORKER_ENTRY?.trim();
  if (configured) {
    return pathToFileURL(path.resolve(configured));
  }
  const currentPath = fileURLToPath(import.meta.url);
  return new URL(currentPath.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js", import.meta.url);
}

const require = createRequire(import.meta.url);

function createActivityWorker(
  workerEntry: URL,
  workerData: ActivityDatabaseOptions,
): Worker {
  if (!workerEntry.pathname.endsWith(".ts")) {
    return new Worker(workerEntry, { workerData });
  }
  const bootstrap = [
    `require(${JSON.stringify(require.resolve("tsx/cjs"))});`,
    `require(${JSON.stringify(fileURLToPath(workerEntry))});`,
  ].join("\n");
  return new Worker(bootstrap, { eval: true, workerData });
}

export class ActivityStore {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly workerExit: Promise<void>;
  private nextRequestId = 1;
  private closed = false;

  private constructor(params: {
    databasePath: string;
    env: NodeJS.ProcessEnv;
  }) {
    const workerEntry = resolveWorkerEntry(params.env);
    this.worker = createActivityWorker(workerEntry, {
      databasePath: params.databasePath,
      contentKeyBase64: null,
      activityKeyEnvironment: {
        testMode: params.env.RUNWEAVE_ACTIVITY_TEST_MODE === "true",
        testKey: params.env.RUNWEAVE_ACTIVITY_TEST_KEY?.trim() || null,
      },
      maxDatabaseBytes:
        params.env.RUNWEAVE_ACTIVITY_TEST_MODE === "true" &&
        params.env.RUNWEAVE_ACTIVITY_TEST_MAX_DATABASE_BYTES
          ? Number(params.env.RUNWEAVE_ACTIVITY_TEST_MAX_DATABASE_BYTES)
          : undefined,
    });
    let resolveWorkerExit: (() => void) | undefined;
    this.workerExit = new Promise<void>((resolve) => {
      resolveWorkerExit = resolve;
    });
    this.worker.on("message", (response: ActivityWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error));
      }
    });
    this.worker.on("error", (error) => this.rejectAll(error));
    this.worker.on("exit", (code) => {
      resolveWorkerExit?.();
      if (!this.closed && code !== 0) {
        this.rejectAll(new Error(`activity_sqlite_worker_exited:${code}`));
      }
    });
  }

  static async create(params: {
    databasePath: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ActivityStore> {
    const env = params.env ?? process.env;
    const store = new ActivityStore({
      databasePath: params.databasePath,
      env,
    });
    const healthy = await store.integrity();
    if (!healthy) {
      await store.close();
      throw new Error("activity_integrity_check_failed");
    }
    return store;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request<T extends ActivityWorkerResult>(
    request: ActivityWorkerCommand,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("activity_store_closed"));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ ...request, id });
    });
  }

  record(events: ActivityEventInput[], nowMs?: number): Promise<ActivityWriteAck[]> {
    return this.request({ op: "record", events, ...(nowMs != null ? { nowMs } : {}) });
  }

  facts(query: ActivityFactsQuery): Promise<ActivityFactsPage> {
    return this.request({ op: "facts", query });
  }

  timeline(
    selector: ActivityTimelineSelector,
    query: ActivityFactsQuery,
  ): Promise<ActivityFactsPage> {
    return this.request({ op: "timeline", selector, query });
  }

  sources(): Promise<ActivitySourceDto[]> {
    return this.request({ op: "sources" });
  }

  policy(): Promise<ActivityDataPolicyDto> {
    return this.request({ op: "policy" });
  }

  content(contentId: string): Promise<ActivityContentValueDto | null> {
    return this.request({ op: "content", contentId });
  }

  auditSubjectHmac(subject: string): Promise<string> {
    return this.request({ op: "audit-subject-hmac", subject });
  }

  recordRejection(input: ActivityIngestRejectionInput): Promise<void> {
    return this.request({ op: "rejection", ...input }).then(() => undefined);
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
  }): Promise<void> {
    return this.request({ op: "audit", ...params }).then(() => undefined);
  }

  preview(
    scope: ActivityOperationScope,
    asOfActivityOffset?: number,
  ): Promise<ActivityMembershipSnapshot> {
    return this.request({
      op: "preview",
      scope,
      ...(asOfActivityOffset != null ? { asOfActivityOffset } : {}),
    });
  }

  exportSnapshot(params: {
    scope: ActivityOperationScope;
    asOfActivityOffset: number;
  }) {
    return this.request({ op: "export-snapshot", ...params });
  }

  createDeleteJob(params: {
    requestId: string;
    backendInstanceId: string;
    authSubjectHmac: string;
    scope: ActivityOperationScope;
    snapshot: ActivityMembershipSnapshot;
    nowMs?: number;
  }): Promise<ActivityDeleteJobDto> {
    return this.request({ op: "create-delete-job", ...params });
  }

  deleteStatus(deleteJobId: string): Promise<ActivityDeleteJobDto | null> {
    return this.request({ op: "delete-status", deleteJobId });
  }

  runDelete(ownerId: string, nowMs?: number): Promise<ActivityDeleteJobDto | null> {
    return this.request({ op: "run-delete", ownerId, ...(nowMs != null ? { nowMs } : {}) });
  }

  runRetention(ownerId: string, nowMs?: number): Promise<number> {
    return this.request({ op: "run-retention", ownerId, ...(nowMs != null ? { nowMs } : {}) });
  }

  integrity(): Promise<boolean> {
    return this.request({ op: "integrity" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.request({ op: "close" }).catch(() => undefined);
    this.closed = true;
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.workerExit.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2_000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited) await this.worker.terminate();
    this.rejectAll(new Error("activity_store_closed"));
  }
}
