import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { ExperienceLearningStatus } from "@runweave/shared/experience";
import type { ActivityStore } from "../activity/recording/store";
import type { ExperienceService } from "./service";
import { ExperienceLearningAnalysis } from "./learning-analysis";
import { ExperienceLearningQueue, digest } from "./learning-queue";
import { LearningDeferred } from "./learning-segments";
import { readLearningFacts, type LearningFact } from "./learning-source";
import type { ExperienceStorage } from "./storage";

export class ExperienceLearningRuntime {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopping = false;
  readonly queue: ExperienceLearningQueue;
  readonly analysis: ExperienceLearningAnalysis;
  constructor(
    private readonly storage: ExperienceStorage,
    private readonly service: ExperienceService,
    private readonly activity: ActivityStore | null,
    readonly enabled: boolean,
    private readonly channel: "stable" | "beta" | "dev",
    private readonly onError: (error: unknown) => void,
  ) {
    this.queue = new ExperienceLearningQueue(storage);
    this.analysis = new ExperienceLearningAnalysis(service, this.queue);
  }
  start(): void {
    if (!this.enabled || this.timer || this.stopping) return;
    this.timer = setInterval(() => this.tick(), 5_000);
    this.timer.unref();
    this.tick();
  }
  async enqueue(event: TerminalEventEnvelope): Promise<void> {
    if (!this.enabled || this.stopping || event.kind !== "completion") return;
    const p = event.payload;
    if (
      p.completionReason !== "hook_stop" ||
      p.rawHookEvent?.toLowerCase() !== "stop" ||
      !p.cwd ||
      !p.threadId ||
      !["codex", "pi"].includes(p.source)
    )
      return;
    const scope = await this.service.scope(p.cwd);
    const snapshot = await this.activity?.facts({
      threadId: p.threadId,
      terminalSessionId: event.terminalSessionId,
      runtimeChannel: this.channel,
      limit: 1,
    });
    this.queue.enqueue({
      jobId: digest(
        [
          scope.repositoryId,
          event.terminalSessionId,
          p.panelId,
          p.threadId,
          p.operationId,
          p.completionRevision,
        ].join("\0"),
      ),
      repositoryId: scope.repositoryId,
      cwd: scope.root,
      threadId: p.threadId,
      createdAt: event.createdAt,
      source: {
        terminalSessionId: event.terminalSessionId,
        threadId: p.threadId,
        panelId: p.panelId ?? null,
        completedAt: event.createdAt,
        channel: this.channel,
        asOfActivityOffset: snapshot?.asOfActivityOffset,
      },
    });
  }
  async status(cwd: string): Promise<ExperienceLearningStatus> {
    const scope = await this.service.scope(cwd);
    return {
      enabled: this.enabled,
      repositoryId: scope.repositoryId,
      namespace: this.storage.namespace,
      jobs: this.queue
        .list(scope.repositoryId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50)
        .map(
          ({ source: _source, claim: _claim, leaseUntil: _lease, ...job }) => {
            void _source;
            void _claim;
            void _lease;
            return job;
          },
        ),
      candidates: await this.service.candidates(cwd),
    };
  }
  async retry(cwd: string, jobId: string): Promise<void> {
    this.queue.retry((await this.service.scope(cwd)).repositoryId, jobId);
    this.tick();
  }
  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    await this.running;
  }
  private tick(): void {
    if (!this.enabled || this.stopping || this.running) return;
    this.running = this.work()
      .catch(this.onError)
      .finally(() => {
        this.running = null;
      });
  }
  private async work(): Promise<void> {
    const job = this.queue.claim();
    if (!job) return;
    this.abort = new AbortController();
    const heartbeat = setInterval(() => {
      try {
        this.queue.update(job, {});
      } catch {
        this.abort?.abort();
      }
    }, 30_000);
    heartbeat.unref();
    try {
      const cached = this.queue.checkpoint(job, "source-v1") as
        | LearningFact[]
        | undefined;
      const facts =
        cached ?? (await readLearningFacts(this.activity, job.source));
      this.abort.signal.throwIfAborted();
      if (!cached) this.queue.saveCheckpoint(job, "source-v1", facts);
      const result = await this.analysis.run(job, facts, this.abort.signal);
      this.queue.clearCheckpoints(job);
      this.queue.update(job, result);
    } catch (error) {
      this.queue.update(job, {
        status:
          this.stopping || error instanceof LearningDeferred
            ? "queued"
            : "failed",
        reason: this.stopping
          ? "interrupted_for_restart"
          : error instanceof Error
            ? error.message
            : "experience_learning_failed",
      });
      if (!this.stopping && !(error instanceof LearningDeferred))
        this.onError(error);
    } finally {
      clearInterval(heartbeat);
      this.abort = null;
    }
  }
}
