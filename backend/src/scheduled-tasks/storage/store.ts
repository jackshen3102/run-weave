import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTerminalBinding,
} from "@runweave/shared/scheduled-tasks";
import type {
  ScheduledOutputChunk,
  ScheduledTaskWorkerRequest,
  ScheduledTaskWorkerResponse,
  ScheduledTaskWorkerResult,
} from "./worker-protocol";

interface PendingRequest {
  resolve: (value: ScheduledTaskWorkerResult) => void;
  reject: (error: Error) => void;
}

const require = createRequire(import.meta.url);

export class ScheduledTaskStore {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly workerExit: Promise<void>;
  private nextRequestId = 1;
  private closed = false;
  private disposePromise: Promise<void> | null = null;

  private constructor(databasePath: string, env: NodeJS.ProcessEnv) {
    const entry = resolveWorkerEntry(env);
    this.worker = createWorker(entry, databasePath);
    let resolveExit: (() => void) | undefined;
    this.workerExit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.worker.on("message", (response: ScheduledTaskWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    });
    this.worker.on("error", (error) => this.rejectAll(error));
    this.worker.on("exit", (code) => {
      resolveExit?.();
      if (!this.closed && code !== 0)
        this.rejectAll(new Error(`scheduled_tasks_worker_exited:${code}`));
    });
  }

  static async create(params: {
    databasePath: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ScheduledTaskStore> {
    const store = new ScheduledTaskStore(
      params.databasePath,
      params.env ?? process.env,
    );
    try {
      if (!(await store.request<boolean>({ op: "integrity" })))
        throw new Error("scheduled_tasks_integrity_check_failed");
      return store;
    } catch (error) {
      store.closed = true;
      await store.worker.terminate();
      throw error;
    }
  }

  createTask(
    task: ScheduledTask,
    parentProjectId: string,
    idempotencyKey: string,
    requestHash: string,
  ) {
    return this.request<ScheduledTask>({
      op: "create-task",
      task,
      parentProjectId,
      idempotencyKey,
      requestHash,
    });
  }
  getTask(taskId: string) {
    return this.request<ScheduledTask | null>({ op: "get-task", taskId });
  }
  listTasks() {
    return this.request<ScheduledTask[]>({ op: "list-tasks" });
  }
  updateTask(
    task: ScheduledTask,
    expectedRevision: number,
    parentProjectId: string,
  ) {
    return this.request<ScheduledTask>({
      op: "update-task",
      task,
      expectedRevision,
      parentProjectId,
    });
  }
  listDueTasks(through: string) {
    return this.request<ScheduledTask[]>({ op: "list-due-tasks", through });
  }
  materializeScheduledRun(
    run: ScheduledRun,
    occurrenceKey: string,
    nextRunAt: string | null,
    taskRevision: number,
  ) {
    return this.request<ScheduledRun>({
      op: "materialize-scheduled-run",
      run,
      occurrenceKey,
      nextRunAt,
      taskRevision,
    });
  }
  createManualRun(
    run: ScheduledRun,
    idempotencyKey: string,
    requestHash: string,
  ) {
    return this.request<ScheduledRun>({
      op: "create-manual-run",
      run,
      idempotencyKey,
      requestHash,
    });
  }
  getRun(runId: string) {
    return this.request<ScheduledRun | null>({ op: "get-run", runId });
  }
  listRuns(taskId: string) {
    return this.request<ScheduledRun[]>({ op: "list-runs", taskId });
  }
  claimNextRun(ownerId: string, now: string) {
    return this.request<ScheduledRun | null>({
      op: "claim-next-run",
      ownerId,
      now,
    });
  }
  putRun(run: ScheduledRun) {
    return this.request<ScheduledRun>({ op: "put-run", run });
  }
  setRunOwnerPid(runId: string, ownerId: string, ownerPid: number) {
    return this.request<boolean>({
      op: "set-run-owner-pid",
      runId,
      ownerId,
      ownerPid,
    });
  }
  recoverInterruptedRuns(now: string, currentOwnerId: string) {
    return this.request<ScheduledRun[]>({
      op: "recover-interrupted-runs",
      now,
      currentOwnerId,
    });
  }
  requestRunStop(runId: string, now: string) {
    return this.request<ScheduledRun>({ op: "request-run-stop", runId, now });
  }
  appendOutput(runId: string, text: string, maxBytes: number) {
    return this.request<boolean>({
      op: "append-output",
      runId,
      text,
      maxBytes,
    });
  }
  readOutput(runId: string, offset: number, maxBytes: number) {
    return this.request<ScheduledOutputChunk>({
      op: "read-output",
      runId,
      offset,
      maxBytes,
    });
  }
  putBinding(runId: string, binding: ScheduledTerminalBinding) {
    return this.request<ScheduledRun>({ op: "put-binding", runId, binding });
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.closeWorker();
    return this.disposePromise;
  }

  private async closeWorker(): Promise<void> {
    if (this.closed) return;
    await this.request<boolean>({ op: "close" });
    this.closed = true;
    await this.workerExit;
    this.rejectAll(new Error("scheduled_tasks_store_closed"));
  }

  private request<T extends ScheduledTaskWorkerResult>(
    command: ScheduledTaskWorkerRequest,
  ): Promise<T> {
    if (this.closed || (this.disposePromise && command.op !== "close"))
      return Promise.reject(new Error("scheduled_tasks_store_closed"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ ...command, id });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function resolveWorkerEntry(env: NodeJS.ProcessEnv): URL {
  const configured = env.RUNWEAVE_SCHEDULED_TASKS_WORKER_ENTRY?.trim();
  if (configured) return pathToFileURL(path.resolve(configured));
  const current = fileURLToPath(import.meta.url);
  return new URL(
    current.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js",
    import.meta.url,
  );
}

function createWorker(entry: URL, databasePath: string): Worker {
  if (!entry.pathname.endsWith(".ts"))
    return new Worker(entry, { workerData: { databasePath } });
  const bootstrap = [
    `require(${JSON.stringify(require.resolve("tsx/cjs"))});`,
    `require(${JSON.stringify(fileURLToPath(entry))});`,
  ].join("\n");
  return new Worker(bootstrap, { eval: true, workerData: { databasePath } });
}
