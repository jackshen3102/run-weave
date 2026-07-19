import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  CandidateAsset,
  EvolutionScopePolicy,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";
import type { EvolutionActivationStore } from "../activation-store";
import type {
  EvolutionWorkerRequest,
  EvolutionWorkerResponse,
  EvolutionWorkerResult,
} from "./worker-protocol";

interface PendingRequest {
  resolve: (value: EvolutionWorkerResult) => void;
  reject: (error: Error) => void;
}

const require = createRequire(import.meta.url);

function resolveWorkerEntry(env: NodeJS.ProcessEnv): URL {
  const configured = env.RUNWEAVE_EVOLUTION_WORKER_ENTRY?.trim();
  if (configured) return pathToFileURL(path.resolve(configured));
  const currentPath = fileURLToPath(import.meta.url);
  return new URL(
    currentPath.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js",
    import.meta.url,
  );
}

function createWorker(workerEntry: URL, databasePath: string): Worker {
  if (!workerEntry.pathname.endsWith(".ts")) {
    return new Worker(workerEntry, { workerData: { databasePath } });
  }
  const bootstrap = [
    `require(${JSON.stringify(require.resolve("tsx/cjs"))});`,
    `require(${JSON.stringify(fileURLToPath(workerEntry))});`,
  ].join("\n");
  return new Worker(bootstrap, {
    eval: true,
    workerData: { databasePath },
  });
}

export class SqliteEvolutionActivationStore implements EvolutionActivationStore {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly workerExit: Promise<void>;
  private nextRequestId = 1;
  private closed = false;

  private constructor(databasePath: string, env: NodeJS.ProcessEnv) {
    this.worker = createWorker(resolveWorkerEntry(env), databasePath);
    let resolveWorkerExit: (() => void) | undefined;
    this.workerExit = new Promise<void>((resolve) => {
      resolveWorkerExit = resolve;
    });
    this.worker.on("message", (response: EvolutionWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    });
    this.worker.on("error", (error) => this.rejectAll(error));
    this.worker.on("exit", (code) => {
      resolveWorkerExit?.();
      if (!this.closed && code !== 0) {
        this.rejectAll(new Error(`evolution_sqlite_worker_exited:${code}`));
      }
    });
  }

  static async create(params: {
    databasePath: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<SqliteEvolutionActivationStore> {
    const store = new SqliteEvolutionActivationStore(
      params.databasePath,
      params.env ?? process.env,
    );
    if (!(await store.request<boolean>({ op: "integrity" }))) {
      await store.close();
      throw new Error("evolution_integrity_check_failed");
    }
    return store;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request<T extends EvolutionWorkerResult>(
    command: EvolutionWorkerRequest,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("evolution_store_closed"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ ...command, id });
    });
  }

  listCandidates(): Promise<CandidateAsset[]> {
    return this.request({ op: "list-candidates" });
  }

  async putCandidate(candidate: CandidateAsset): Promise<void> {
    await this.request({ op: "put-candidate", candidate });
  }

  getPolicy(learningScopeId: string): Promise<EvolutionScopePolicy | null> {
    return this.request({ op: "get-policy", learningScopeId });
  }

  async putPolicy(policy: EvolutionScopePolicy): Promise<void> {
    await this.request({ op: "put-policy", policy });
  }

  async putRuntimeTrace(trace: RuntimeTraceSummary): Promise<void> {
    await this.request({ op: "put-trace", trace });
  }

  async appendRuntimeTraceEvent(
    traceId: string,
    event: RuntimeTraceEvent,
  ): Promise<void> {
    if (event.traceId !== traceId)
      throw new Error("runtime_trace_event_mismatch");
    await this.request({ op: "append-trace-event", event });
  }

  getRuntimeTrace(traceId: string): Promise<RuntimeTraceSummary | null> {
    return this.request({ op: "get-trace", traceId });
  }

  listRuntimeTraces(runId: string): Promise<RuntimeTraceSummary[]> {
    return this.request({ op: "list-traces", runId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
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
    this.rejectAll(new Error("evolution_store_closed"));
  }
}
