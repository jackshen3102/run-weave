import { randomUUID } from "node:crypto";
import type { ReviewInput, SuijiReview } from "@runweave/shared/suiji";
import type { Config } from "../config";
import type { RecordService } from "../records/service";
import type { AttachmentService } from "../storage/attachments";
import { digest } from "../records/mutations";
import { missing, ServiceError } from "../errors";
import { ReviewContext } from "./context";
import { runCodex } from "./codex";

type Job = {
  owner: string;
  key: string;
  digest: string;
  value: SuijiReview;
  abort: AbortController;
  finished?: number;
};
export class ReviewService {
  private jobs = new Map<string, Job>();
  private closed = false;
  constructor(
    private config: Config,
    private records: RecordService,
    private attachments: AttachmentService,
  ) {}
  info() {
    return {
      enabled: this.config.SUIJI_AI_PROVIDER === "codex-cli",
      provider: this.config.SUIJI_AI_PROVIDER,
    };
  }
  private prune() {
    for (const [id, job] of this.jobs)
      if (job.finished && job.finished < Date.now() - 30 * 60_000)
        this.jobs.delete(id);
  }
  start(
    owner: string,
    key: string,
    input: ReviewInput,
    requestId: string,
  ): SuijiReview {
    this.prune();
    if (this.closed || !this.info().enabled)
      throw new ServiceError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "此服务尚未启用 AI 回顾",
      );
    const fingerprint = digest(input);
    const previous = [...this.jobs.values()].find(
      (job) => job.owner === owner && job.key === key,
    );
    if (previous) {
      if (previous.digest !== fingerprint)
        throw new ServiceError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "该回顾请求键已用于其他问题",
        );
      return previous.value;
    }
    if (
      [...this.jobs.values()].some(
        (job) => job.owner === owner && !job.finished,
      ) ||
      this.jobs.size >= 100
    )
      throw new ServiceError(
        429,
        "RATE_LIMITED",
        "已有回顾在进行中或已达到本地任务限额，请稍后手动重试",
      );
    const id = randomUUID(),
      abort = new AbortController();
    const job: Job = {
      owner,
      key,
      digest: fingerprint,
      abort,
      value: { id, status: "running", createdAt: new Date().toISOString() },
    };
    this.jobs.set(id, job);
    const context = new ReviewContext(
      this.records,
      this.attachments,
      owner,
      input.scope,
      abort.signal,
    );
    const timeout = setTimeout(() => {
      job.value = {
        ...job.value,
        status: "failed",
        error: "回顾超时，请缩小范围后手动重试",
      };
      abort.abort();
    }, this.config.SUIJI_AI_TIMEOUT_SECONDS * 1000);
    timeout.unref();
    void runCodex(this.config, context, input, requestId, abort.signal)
      .then((answer) => {
        if (!abort.signal.aborted)
          job.value = { ...job.value, status: "completed", answer };
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          job.value = {
            ...job.value,
            status: "failed",
            error:
              error instanceof ServiceError
                ? error.message
                : "Codex 回顾未完成或引用核验失败，请检查 CLI 登录后手动重试",
          };
      })
      .finally(() => {
        clearTimeout(timeout);
        job.finished = Date.now();
      });
    return job.value;
  }
  get(owner: string, id: string) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw missing();
    return job.value;
  }
  cancel(owner: string, id: string) {
    this.get(owner, id);
    const job = this.jobs.get(id)!;
    if (job.value.status === "running") {
      job.value = { ...job.value, status: "cancelled" };
      job.abort.abort();
    }
    return job.value;
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.abort.abort();
  }
}
