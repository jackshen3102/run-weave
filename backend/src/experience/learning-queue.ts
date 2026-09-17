import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ExperienceLearningJob } from "@runweave/shared/experience";
import { withExperienceStore, type ExperienceStorage } from "./storage";
import type { LearningSource } from "./learning-source";

export interface LearningJob extends ExperienceLearningJob {
  source: LearningSource;
  claim: string | null;
  leaseUntil: number;
  sourceDigest?: string;
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export class ExperienceLearningQueue {
  readonly directory: string;
  constructor(storage: ExperienceStorage) {
    this.directory = path.join(storage.home, storage.namespace, "_queue");
  }
  enqueue(
    input: Omit<
      LearningJob,
      | "status"
      | "attempts"
      | "updatedAt"
      | "reason"
      | "candidateId"
      | "claim"
      | "leaseUntil"
    >,
  ): LearningJob {
    return withExperienceStore(this.directory, (store) =>
      store.transaction(() => {
        const existing = store.get<LearningJob>("jobs", input.jobId);
        if (existing) return existing;
        const job: LearningJob = {
          ...input,
          status: "queued",
          attempts: 0,
          updatedAt: input.createdAt,
          reason: null,
          candidateId: null,
          claim: null,
          leaseUntil: 0,
        };
        store.put("jobs", job.jobId, job);
        return job;
      }),
    );
  }
  list(repositoryId?: string): LearningJob[] {
    return withExperienceStore(this.directory, (store) =>
      store.list<LearningJob>("jobs"),
    ).filter((job) => !repositoryId || job.repositoryId === repositoryId);
  }
  claim(): LearningJob | null {
    return withExperienceStore(this.directory, (store) =>
      store.transaction(() => {
        const jobs = store.list<LearningJob>("jobs");
        const now = Date.now();
        if (
          jobs.some((job) => job.status === "running" && job.leaseUntil > now)
        )
          return null;
        const job = jobs
          .filter(
            (j) =>
              j.status === "queued" ||
              (j.status === "running" && j.leaseUntil <= now),
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!job) return null;
        const claimed: LearningJob = {
          ...job,
          status: "running",
          attempts: job.attempts + 1,
          claim: randomUUID(),
          leaseUntil: now + 5 * 60_000,
          updatedAt: new Date().toISOString(),
        };
        store.put("jobs", job.jobId, claimed);
        return claimed;
      }),
    );
  }
  update(job: LearningJob, update: Partial<LearningJob>): void {
    withExperienceStore(this.directory, (store) =>
      store.transaction(() => {
        const current = store.get<LearningJob>("jobs", job.jobId);
        if (
          current?.claim !== job.claim ||
          current?.status !== "running" ||
          current.leaseUntil <= Date.now()
        )
          throw new Error("experience_learning_claim_lost");
        store.put("jobs", job.jobId, {
          ...current,
          ...update,
          updatedAt: new Date().toISOString(),
        });
      }),
    );
  }
  retry(repositoryId: string, jobId: string): void {
    withExperienceStore(this.directory, (store) =>
      store.transaction(() => {
        const job = store.get<LearningJob>("jobs", jobId);
        if (!job || job.repositoryId !== repositoryId)
          throw new Error("experience_job_not_found");
        if (job.status !== "failed")
          throw new Error("experience_job_not_failed");
        store.put("jobs", jobId, {
          ...job,
          status: "queued",
          claim: null,
          reason: null,
        });
      }),
    );
  }
}
