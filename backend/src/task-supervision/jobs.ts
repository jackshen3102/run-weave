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
  async runUntilCanceled(id: string, job: Job) {
    this.add(id, job);
    // Free the reply queue on cancellation; retain the actual work until shutdown.
    void job.promise.finally(() => this.finish(id, job)).catch(() => undefined);
    let aborted: (() => void) | undefined;
    try {
      await Promise.race([
        job.promise,
        new Promise<void>((resolve) => {
          aborted = () => resolve();
          if (job.controller.signal.aborted) resolve();
          else
            job.controller.signal.addEventListener("abort", aborted, {
              once: true,
            });
        }),
      ]);
    } finally {
      if (aborted) job.controller.signal.removeEventListener("abort", aborted);
    }
  }
  async drain() {
    await Promise.allSettled([...this.pending].map((job) => job.promise));
  }
}
