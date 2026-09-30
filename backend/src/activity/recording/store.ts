import { resolveActivityRepositories } from "./repository-bindings";
import { logger } from "../../logging/index";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  ActivityDataPolicyDto,
  ActivityContentValueDto,
  ActivityDeleteJobDto,
  ActivityEventInput,
  ActivityEvolutionEvidenceAvailability,
  ActivityEvolutionSnapshotPage,
  ActivityEvolutionSnapshotQuery,
  ActivityFactsPage,
  ActivityFactsQuery,
  ActivityOperationScope,
  ActivitySourceDto,
  ActivityTimelineSelector,
  ActivityWriteAck,
} from "@runweave/shared/activity";
import type { ActivityMembershipSnapshot } from "../database/maintenance";
import type { ActivityIngestRejectionInput } from "../database/rejection";
import type { ActivityDatabaseOptions } from "../database/connection";
import type {
  ActivityWorkerCommand,
  ActivityWorkerResponse,
  ActivityWorkerResult,
} from "../database/worker-protocol";

interface PendingRequest {
  resolve: (value: ActivityWorkerResult) => void;
  reject: (error: Error) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 500;

function resolveWorkerEntry(env: NodeJS.ProcessEnv): URL {
  const configured = env.RUNWEAVE_ACTIVITY_WORKER_ENTRY?.trim();
  if (configured) {
    return pathToFileURL(path.resolve(configured));
  }
  const currentPath = fileURLToPath(import.meta.url);
  return new URL(
    currentPath.endsWith(".ts")
      ? "../database/sqlite-worker.ts"
      : "../database/sqlite-worker.js",
    import.meta.url,
  );
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
  private closing = false;
  private failure: Error | null = null;
  private readonly operationRejections = new Set<(error: Error) => void>();
  private disposal: Promise<void> | null = null;
  private readonly recording = new Set<Promise<ActivityWriteAck[]>>();

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
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      resolveWorkerExit?.();
      if (!this.closed) {
        this.fail(new Error(`activity_sqlite_worker_exited:${code}`));
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
    try {
      // The worker handles requests only after database and key initialization.
      // Full integrity scans remain an explicit diagnostic operation.
      await store.request({ op: "ready" });
      return store;
    } catch (error) {
      // The factory owns the worker until it successfully returns a store.
      store.fail(new Error("activity_store_closed"));
      try {
        await store.close();
      } catch (cleanupError) {
        logger.warn("activity.initialize.cleanup.failed", {
          component: "activity",
          message: "Activity initialization failed and worker cleanup also failed",
          error: cleanupError,
        });
      }
      throw error;
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  isAvailable(): boolean {
    return !this.failure && !this.closing && !this.closed;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const reject of this.operationRejections) reject(error);
    this.operationRejections.clear();
    this.rejectAll(error);
    void this.worker.terminate().catch(() => undefined);
  }

  private withDeadline<T>(
    operation: () => Promise<T>,
    name: string,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("activity_store_closed"));
    }
    if (this.failure) return Promise.reject(this.failure);
    let rejectOperation!: (error: Error) => void;
    const result = new Promise<T>((resolve, reject) => {
      rejectOperation = reject;
      this.operationRejections.add(rejectOperation);
      try {
        void operation().then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
    const timeout = setTimeout(
      () => this.fail(new Error(`activity_sqlite_worker_timeout:${name}`)),
      REQUEST_TIMEOUT_MS,
    );
    return result.finally(() => {
      clearTimeout(timeout);
      this.operationRejections.delete(rejectOperation);
    });
  }

  private request<T extends ActivityWorkerResult>(
    request: ActivityWorkerCommand,
  ): Promise<T> {
    return this.withDeadline(() => {
      const id = this.nextRequestId++;
      return new Promise<T>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        try {
          this.worker.postMessage({ ...request, id });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    }, request.op);
  }

  record(
    events: ActivityEventInput[],
    nowMs?: number,
  ): Promise<ActivityWriteAck[]> {
    if (this.closing || this.closed)
      return Promise.reject(new Error("activity_store_closed"));
    const operation = this.withDeadline(async () => {
      const bindings = await resolveActivityRepositories(
        events.map((event) => ({ eventId: event.eventId, cwd: event.scope.cwd })),
      );
      return this.request<ActivityWriteAck[]>({
        op: "record",
        events,
        bindings,
        ...(nowMs != null ? { nowMs } : {}),
      });
    }, "record");
    this.recording.add(operation);
    void operation.then(
      () => this.recording.delete(operation),
      () => this.recording.delete(operation),
    );
    return operation;
  }

  facts(query: ActivityFactsQuery): Promise<ActivityFactsPage> {
    return this.withDeadline(async () => {
      await Promise.allSettled([...this.recording]);
      return this.request({ op: "facts", query });
    }, "facts");
  }

  evolutionSnapshot(
    query: ActivityEvolutionSnapshotQuery,
  ): Promise<ActivityEvolutionSnapshotPage> {
    return this.withDeadline(async () => {
      await Promise.allSettled([...this.recording]);
      if (query.atOrBeforeSnapshotBoundary === undefined) {
        const pending = await this.request<
          Array<{ eventId: string; cwd: string | null }>
        >({ op: "pending-repositories" });
        if (pending.length)
          await this.request({
            op: "bind-repositories",
            bindings: await resolveActivityRepositories(pending),
          });
      }
      return this.request({ op: "evolution-snapshot", query });
    }, "evolution-snapshot");
  }

  evolutionEvidenceAvailability(
    eventIds: string[],
  ): Promise<ActivityEvolutionEvidenceAvailability[]> {
    return this.request({ op: "evolution-evidence-availability", eventIds });
  }

  timeline(
    selector: ActivityTimelineSelector,
    query: ActivityFactsQuery,
  ): Promise<ActivityFactsPage> {
    return this.withDeadline(async () => {
      await Promise.allSettled([...this.recording]);
      return this.request({ op: "timeline", selector, query });
    }, "timeline");
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

  runDelete(
    ownerId: string,
    nowMs?: number,
  ): Promise<ActivityDeleteJobDto | null> {
    return this.request({
      op: "run-delete",
      ownerId,
      ...(nowMs != null ? { nowMs } : {}),
    });
  }

  runRetention(ownerId: string, nowMs?: number): Promise<number> {
    return this.request({
      op: "run-retention",
      ownerId,
      ...(nowMs != null ? { nowMs } : {}),
    });
  }

  integrity(): Promise<boolean> {
    return this.request({ op: "integrity" });
  }

  close(): Promise<void> {
    if (!this.disposal) {
      this.closing = true;
      this.disposal = this.closeWorker();
    }
    return this.disposal;
  }

  private async closeWorker(): Promise<void> {
    const graceful = Promise.allSettled([...this.recording]).then(async () => {
      if (this.closed) return;
      if (!this.failure) void this.request({ op: "close" }).catch(() => undefined);
      this.closed = true;
      await this.workerExit;
    });
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      graceful.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.closed = true;
    this.fail(new Error("activity_store_closed"));
    if (!exited) {
      try {
        await Promise.race([
          this.workerExit,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("activity_sqlite_worker_termination_timeout")),
              TERMINATION_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }
}
