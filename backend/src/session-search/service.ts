import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { SessionSearchContext, SessionSearchQuery, SessionSearchResponse, SessionSearchStatus } from "@runweave/shared/session-search";
import { nativeSearchRoots, type NativeSearchRoot } from "./scanner";
import type { SearchWorkerCommand, SearchWorkerOptions, SearchWorkerResponse } from "./protocol";
import { resolveRepositoryIdentity } from "../repository/identity";
import { finishWorkerShutdown } from "../utils/worker-shutdown";

export class SessionSearchError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export class SessionSearchService {
  private worker?: Worker;
  private exited: Promise<void> = Promise.resolve();
  private opening?: Promise<void>;
  private disposal?: Promise<void>;
  private closing = false;
  private failed = false;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private file: string, private projectPath: (id: string) => string | null | undefined,
    private roots: NativeSearchRoot[] = nativeSearchRoots()) {}

  private ensure(): Promise<void> {
    if (this.closing) return Promise.reject(new SessionSearchError(503, "session_search_closed"));
    if (this.worker && !this.failed) return Promise.resolve();
    return this.opening ??= this.spawn().finally(() => { this.opening = undefined; });
  }
  private async spawn() {
    await this.exited;
    if (this.closing) throw new SessionSearchError(503, "session_search_closed");
    const current = fileURLToPath(import.meta.url);
    const entry = new URL(current.endsWith(".cjs") ? "./session-search-worker.cjs" : current.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
    const workerData: SearchWorkerOptions = { file: this.file, roots: this.roots };
    const worker = entry.pathname.endsWith(".ts")
      ? new Worker(`require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});require(${JSON.stringify(fileURLToPath(entry))});`, { eval: true, workerData })
      : new Worker(entry, { workerData });
    this.worker = worker; this.failed = false;
    this.exited = new Promise(resolve => worker.once("exit", resolve));
    worker.on("message", (message: SearchWorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(this.error(message.error)); else pending.resolve(message.value);
    });
    worker.on("error", () => this.fail(worker));
    worker.on("exit", () => this.fail(worker));
    try { await this.post({ op: "ready" }); }
    catch (error) { await worker.terminate(); throw error; }
  }
  private error(code: string) {
    return new SessionSearchError(code.includes("cursor") || code.includes("changed") ? 409 : code.includes("record_unavailable") ? 404 : code.includes("query_invalid") ? 400 : 503, code);
  }
  private fail(worker: Worker) {
    if (this.worker !== worker) return;
    this.failed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new SessionSearchError(503, "session_search_worker_unavailable")); }
    this.pending.clear();
  }
  private post<T>(command: SearchWorkerCommand): Promise<T> {
    const worker = this.worker;
    if (!worker || this.failed) return Promise.reject(new SessionSearchError(503, "session_search_worker_unavailable"));
    if (this.pending.size >= 64) return Promise.reject(new SessionSearchError(503, "session_search_busy"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(worker); void worker.terminate(); }, command.op === "search" || command.op === "context" || command.op === "refresh" ? 30 * 60_000 : 15_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { worker.postMessage({ id, command }); }
      catch { this.fail(worker); void worker.terminate(); }
    });
  }
  private async request<T>(command: SearchWorkerCommand): Promise<T> { await this.ensure(); return this.post<T>(command); }
  status() { return this.request<SessionSearchStatus>({ op: "status" }); }
  refresh() { return this.request<SessionSearchStatus>({ op: "refresh" }); }
  async search(query: SessionSearchQuery): Promise<SessionSearchResponse> {
    let repositoryId: string | undefined;
    if (!query.allProjects) {
      const cwd = query.projectId ? this.projectPath(query.projectId) : query.cwd;
      if (!cwd) throw new SessionSearchError(400, "session_search_project_required");
      try { repositoryId = (await resolveRepositoryIdentity(cwd)).repositoryId; }
      catch { throw new SessionSearchError(409, "session_search_repository_unavailable"); }
    }
    return this.request({ op: "search", query: { ...query, repositoryId } });
  }
  context(id: string, noUpdate = false) { return this.request<SessionSearchContext>({ op: "context", id, noUpdate }); }
  dispose(): Promise<void> { return this.disposal ??= this.close(); }
  private async close() {
    this.closing = true;
    await this.opening?.catch(() => undefined);
    const worker = this.worker;
    if (!worker) return;
    if (!this.failed) void this.post({ op: "close" }).catch(() => undefined);
    try { await finishWorkerShutdown(worker, this.exited, "session_search_worker_close_timeout"); }
    finally { this.fail(worker); }
  }
}
