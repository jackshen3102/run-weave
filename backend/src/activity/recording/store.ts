import { resolveActivityRepositories } from "./repository-bindings";
import { logger } from "../../logging/index";
import type { Worker } from "node:worker_threads";
import {
  createActivityWorker,
  resolveWorkerEntry,
  waitForActivityWorkerExit,
} from "./worker";
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
  operation: string;
  startedAt: number;
  resolve: (value: ActivityWorkerResult) => void;
  reject: (error: Error) => void;
}

interface ActivityWorkerState {
  worker: Worker;
  exit: Promise<void>;
  generation: number;
  failure: Error | null;
  readyAt: number | null;
}

const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 500;
const RECOVERY_BACKOFF_MS = 1_000;
const MAX_RECOVERY_BACKOFF_MS = 30_000;

export class ActivityStore {
  private worker: ActivityWorkerState;
  private readonly workerEntry: URL;
  private readonly workerData: ActivityDatabaseOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private generation = 0;
  private nextRequestId = 1;
  private closed = false;
  private closing = false;
  private initialized = false;
  private recoveryFailures = 0;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recovery: Promise<void> | null = null;
  private readonly operationRejections = new Set<(error: Error) => void>();
  private disposal: Promise<void> | null = null;
  private readonly recording = new Set<Promise<ActivityWriteAck[]>>();

  private constructor(params: {
    databasePath: string;
    env: NodeJS.ProcessEnv;
  }) {
    this.workerEntry = resolveWorkerEntry(params.env);
    this.workerData = {
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
    };
    this.worker = this.createWorker();
  }

  private createWorker(): ActivityWorkerState {
    const worker = createActivityWorker(this.workerEntry, this.workerData);
    let resolveWorkerExit: (() => void) | undefined;
    const exit = new Promise<void>((resolve) => {
      resolveWorkerExit = resolve;
    });
    const state: ActivityWorkerState = {
      worker,
      exit,
      generation: ++this.generation,
      failure: null,
      readyAt: null,
    };
    worker.on("message", (response: ActivityWorkerResponse) => {
      if (state !== this.worker || state.failure) return;
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
    worker.on("error", (error) => this.fail(error, state));
    worker.on("exit", (code) => {
      resolveWorkerExit?.();
      if (!this.closed) {
        this.fail(new Error(`activity_sqlite_worker_exited:${code}`), state);
      }
    });
    return state;
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
      await store.request({ op: "ready" }, store.worker, true);
      store.worker.readyAt = Date.now();
      store.initialized = true;
      return store;
    } catch (error) {
      // The factory owns the worker until it successfully returns a store.
      store.fail(new Error("activity_store_closed"));
      try {
        await store.close();
      } catch (cleanupError) {
        logger.warn("activity.initialize.cleanup.failed", {
          component: "activity",
          message:
            "Activity initialization failed and worker cleanup also failed",
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
    return (
      this.worker.readyAt !== null &&
      !this.worker.failure &&
      !this.closing &&
      !this.closed
    );
  }

  private rejectOperations(error: Error): void {
    for (const reject of this.operationRejections) reject(error);
    this.operationRejections.clear();
    this.rejectAll(error);
  }

  private fail(error: Error, worker = this.worker): void {
    if (worker !== this.worker || worker.failure) return;
    worker.failure = error;
    if (
      worker.readyAt !== null &&
      Date.now() - worker.readyAt >= MAX_RECOVERY_BACKOFF_MS
    ) {
      this.recoveryFailures = 0;
    }
    this.recoveryFailures += 1;
    logger.warn("activity.worker.failed", {
      component: "activity",
      generation: worker.generation,
      pendingOperations: [...this.pending.entries()]
        .slice(0, 20)
        .map(([id, request]) => ({
          id,
          operation: request.operation,
          elapsedMs: Date.now() - request.startedAt,
        })),
      error,
    });
    this.rejectOperations(error);
    void worker.worker.terminate().catch((terminationError) => {
      logger.warn("activity.worker.termination.failed", {
        component: "activity",
        error: terminationError,
      });
    });
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (
      !this.initialized ||
      this.closing ||
      this.closed ||
      this.recoveryTimer ||
      this.recovery
    )
      return;
    const delayMs = Math.min(
      MAX_RECOVERY_BACKOFF_MS,
      RECOVERY_BACKOFF_MS * 2 ** Math.min(this.recoveryFailures - 1, 5),
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.recovery = this.recoverWorker()
        .catch((error) => {
          logger.warn("activity.worker.recovery.failed", {
            component: "activity",
            error,
          });
        })
        .finally(() => {
          this.recovery = null;
          if (this.worker.failure) this.scheduleRecovery();
        });
    }, delayMs);
    this.recoveryTimer.unref();
  }

  private async recoverWorker(): Promise<void> {
    if (
      !(await waitForActivityWorkerExit(
        this.worker.exit,
        TERMINATION_TIMEOUT_MS,
      ))
    ) {
      this.recoveryFailures += 1;
      throw new Error("activity_sqlite_worker_termination_timeout");
    }
    if (this.closing || this.closed) return;
    let worker: ActivityWorkerState;
    try {
      worker = this.createWorker();
    } catch (error) {
      this.recoveryFailures += 1;
      throw error;
    }
    this.worker = worker;
    try {
      await this.request({ op: "ready" }, worker, true);
      if (this.closing || this.closed) return;
      worker.readyAt = Date.now();
      logger.info("activity.worker.recovered", {
        component: "activity",
        generation: worker.generation,
      });
    } catch (error) {
      if (this.closing || this.closed) return;
      this.fail(
        error instanceof Error ? error : new Error(String(error)),
        worker,
      );
      throw error;
    }
  }

  private withDeadline<T>(
    operation: () => Promise<T>,
    name: string,
    worker = this.worker,
    initializing = false,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("activity_store_closed"));
    }
    if (worker !== this.worker)
      return Promise.reject(
        worker.failure ?? new Error("activity_sqlite_worker_replaced"),
      );
    if (worker.failure) return Promise.reject(worker.failure);
    if (!initializing && worker.readyAt === null)
      return Promise.reject(new Error("activity_sqlite_worker_recovering"));
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
      () =>
        this.fail(new Error(`activity_sqlite_worker_timeout:${name}`), worker),
      REQUEST_TIMEOUT_MS,
    );
    return result.finally(() => {
      clearTimeout(timeout);
      this.operationRejections.delete(rejectOperation);
    });
  }

  private request<T extends ActivityWorkerResult>(
    request: ActivityWorkerCommand,
    worker = this.worker,
    initializing = false,
  ): Promise<T> {
    return this.withDeadline(
      () => {
        const id = this.nextRequestId++;
        return new Promise<T>((resolve, reject) => {
          this.pending.set(id, {
            operation: request.op,
            startedAt: Date.now(),
            resolve: (value) => resolve(value as T),
            reject,
          });
          try {
            worker.worker.postMessage({ ...request, id });
          } catch (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      },
      request.op,
      worker,
      initializing,
    );
  }

  record(
    events: ActivityEventInput[],
    nowMs?: number,
  ): Promise<ActivityWriteAck[]> {
    if (this.closing || this.closed)
      return Promise.reject(new Error("activity_store_closed"));
    const worker = this.worker;
    const operation = this.withDeadline(
      async () => {
        const bindings = await resolveActivityRepositories(
          events.map((event) => ({
            eventId: event.eventId,
            cwd: event.scope.cwd,
          })),
        );
        return this.request<ActivityWriteAck[]>(
          {
            op: "record",
            events,
            bindings,
            ...(nowMs != null ? { nowMs } : {}),
          },
          worker,
        );
      },
      "record",
      worker,
    );
    this.recording.add(operation);
    void operation.then(
      () => this.recording.delete(operation),
      () => this.recording.delete(operation),
    );
    return operation;
  }

  facts(query: ActivityFactsQuery): Promise<ActivityFactsPage> {
    const worker = this.worker;
    return this.withDeadline(
      async () => {
        await Promise.allSettled([...this.recording]);
        return this.request({ op: "facts", query }, worker);
      },
      "facts",
      worker,
    );
  }

  evolutionSnapshot(
    query: ActivityEvolutionSnapshotQuery,
  ): Promise<ActivityEvolutionSnapshotPage> {
    const worker = this.worker;
    return this.withDeadline(
      async () => {
        await Promise.allSettled([...this.recording]);
        if (query.atOrBeforeSnapshotBoundary === undefined) {
          const pending = await this.request<
            Array<{ eventId: string; cwd: string | null }>
          >({ op: "pending-repositories" }, worker);
          if (pending.length)
            await this.request(
              {
                op: "bind-repositories",
                bindings: await resolveActivityRepositories(pending),
              },
              worker,
            );
        }
        return this.request({ op: "evolution-snapshot", query }, worker);
      },
      "evolution-snapshot",
      worker,
    );
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
    const worker = this.worker;
    return this.withDeadline(
      async () => {
        await Promise.allSettled([...this.recording]);
        return this.request({ op: "timeline", selector, query }, worker);
      },
      "timeline",
      worker,
    );
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
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.disposal = this.closeWorker();
    }
    return this.disposal;
  }

  private async closeWorker(): Promise<void> {
    // Closing prevents recovery from replacing this generation.
    const worker = this.worker;
    const error = new Error("activity_store_closed");
    const graceful = Promise.allSettled([...this.recording]).then(async () => {
      if (this.closed) return;
      if (!worker.failure && worker.readyAt !== null) {
        void this.request({ op: "close" }, worker).catch(() => undefined);
      } else {
        this.rejectOperations(error);
        void worker.worker.terminate().catch(() => undefined);
      }
      this.closed = true;
      await worker.exit;
      await this.recovery;
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
    this.rejectOperations(error);
    if (!exited) {
      void worker.worker.terminate().catch(() => undefined);
      if (
        !(await waitForActivityWorkerExit(worker.exit, TERMINATION_TIMEOUT_MS))
      ) {
        throw new Error("activity_sqlite_worker_termination_timeout");
      }
    }
  }
}
