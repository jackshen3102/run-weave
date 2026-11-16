import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { finishWorkerShutdown } from "../utils/worker-shutdown";
import type { QualityBatch, QualityContextRequest, QualityContextPage, QualityCoverage, QualityLedger, QualityLedgerCommit, QualityPage, QualityReceipt } from "@runweave/shared/quality-workflow";
import type { LogCheckpoint } from "./database";
export class QualityStoreError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) { super(code); }
}
export type QualityCommand =
  | { op: "ingest"; batch: QualityBatch; projects: Record<string, string | null>; checkpoint?: LogCheckpoint }
  | { op: "events"; cursor?: string; limit: number } | { op: "coverage" } | { op: "ledger"; issueId?: string }
  | { op: "context"; request: QualityContextRequest }
  | { op: "commit"; request: QualityLedgerCommit } | { op: "offsets" } | { op: "close" } | { op: "ready" };
export class QualityStore {
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0; private closing = false; private failure: Error | null = null;
  private exit: Promise<void>; private disposal?: Promise<void>;
  private constructor(private worker: Worker) {
    this.exit = new Promise(resolve => worker.once("exit", () => resolve()));
    worker.on("message", (message: { id: number; result?: unknown; error?: { status: number; code: string; details?: unknown } }) => {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new QualityStoreError(message.error.status, message.error.code, message.error.details)); else pending.resolve(message.result);
    });
    worker.on("error", error => this.fail(error));
    worker.on("exit", () => this.fail(new QualityStoreError(503, "quality_store_unavailable")));
  }
  static async create(file: string, backendId: string, limits?: { maxBytes?: number; retentionDays?: number }) {
    const current = fileURLToPath(import.meta.url);
    const entry = new URL(current.endsWith(".cjs") ? "./quality-workflow-sqlite-worker.cjs" : current.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js", import.meta.url);
    const workerData = { file, backendId, ...limits };
    const worker = entry.pathname.endsWith(".ts") ? new Worker(`require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});require(${JSON.stringify(fileURLToPath(entry))});`, { eval: true, workerData }) : new Worker(entry, { workerData });
    const store = new QualityStore(worker);
    try { await store.request({ op: "ready" }); return store; } catch (error) { await worker.terminate(); throw error; }
  }
  private fail(error: Error) { this.failure ??= error; for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.failure); } this.pending.clear(); }
  private request<T>(command: QualityCommand): Promise<T> {
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new QualityStoreError(503, "quality_store_closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new QualityStoreError(503, "quality_store_timeout")); void this.worker.terminate(); }, 15_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.worker.postMessage({ id, command }); } catch { this.fail(new QualityStoreError(503, "quality_store_unavailable")); }
    });
  }
  ingest(batch: QualityBatch, projects: Record<string, string | null>, checkpoint?: LogCheckpoint) { return this.request<QualityReceipt>({ op: "ingest", batch, projects, checkpoint }); }
  events(cursor?: string, limit = 200) { return this.request<QualityPage>({ op: "events", cursor, limit }); }
  context(request: QualityContextRequest) { return this.request<QualityContextPage>({ op: "context", request }); }
  coverage() { return this.request<QualityCoverage>({ op: "coverage" }); }
  ledger(issueId?: string) { return this.request<QualityLedger>({ op: "ledger", issueId }); }
  commit(request: QualityLedgerCommit) { return this.request<{ revision: number; replayed: boolean }>({ op: "commit", request }); }
  offsets() { return this.request<Record<string, { identity: string; offset: number; missing?: boolean }>>({ op: "offsets" }); }
  dispose(): Promise<void> { return this.disposal ??= this.close(); }
  private async close() {
    if (!this.failure) void this.request({ op: "close" }).catch(() => undefined);
    this.closing = true;
    try { await finishWorkerShutdown(this.worker, this.exit, "quality_worker_close_timeout"); }
    finally { this.fail(new QualityStoreError(503, "quality_store_closed")); }
  }
}
