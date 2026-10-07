import type { SupervisionHookResponse } from "@runweave/shared/task-supervision";

type Job = {
  controller: AbortController;
  promise: Promise<SupervisionHookResponse>;
};

/** Release a canceled watch immediately, but retain its cleanup until shutdown. */
export class SupervisionJobs {
  private readonly active = new Map<string, Job>();
  private readonly pending = new Set<Job>();

  get(id: string) {
    return this.active.get(id);
  }
  add(id: string, job: Job) {
    this.active.set(id, job);
    this.pending.add(job);
  }
  finish(id: string, job: Job) {
    if (this.active.get(id) === job) this.active.delete(id);
    this.pending.delete(job);
  }
  cancel(id: string) {
    this.active.get(id)?.controller.abort();
    this.active.delete(id);
  }
  cancelAll() {
    for (const job of this.pending) job.controller.abort();
    this.active.clear();
  }
  async drain() {
    await Promise.allSettled([...this.pending].map((job) => job.promise));
  }
}
