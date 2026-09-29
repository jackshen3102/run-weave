import { randomUUID } from "node:crypto";
import type { CorrectionInput, SuijiCorrection } from "@runweave/shared/suiji";
import type { Config } from "../config";
import { digest } from "../records/mutations";
import { missing, ServiceError } from "../errors";
import { CorrectionLexicons } from "./lexicon";
import { correctWithCodex, type CorrectionContext } from "./codex";
import { CorrectionHistory } from "./history";

type Job = { owner: string; key: string; digest: string; value: SuijiCorrection; abort: AbortController; finished?: number };
export class CorrectionService {
  private jobs = new Map<string, Job>();
  private closed = false;
  constructor(private config: Config, private lexicons: CorrectionLexicons, private history: CorrectionHistory) {}
  info() { return this.config.SUIJI_AI_PROVIDER === "codex-cli"; }
  cancelOwner(owner: string) {
    for (const job of this.jobs.values()) if (job.owner === owner && job.value.status === "running") this.cancel(owner, job.value.id);
  }
  private prune() {
    for (const [id, job] of this.jobs) if (job.finished && job.finished < Date.now() - 30 * 60_000) this.jobs.delete(id);
  }
  async start(owner: string, key: string, input: CorrectionInput): Promise<SuijiCorrection> {
    this.prune();
    if (this.closed || !this.info()) throw new ServiceError(503, "DEPENDENCY_UNAVAILABLE", "此服务尚未启用文字纠错");
    const fingerprint = digest(input);
    const previous = [...this.jobs.values()].find((job) => job.owner === owner && job.key === key);
    if (previous) {
      if (previous.digest !== fingerprint) throw new ServiceError(409, "IDEMPOTENCY_KEY_REUSED", "该纠错请求键已用于其他文本");
      return previous.value;
    }
    if ([...this.jobs.values()].some((job) => job.owner === owner && !job.finished) || this.jobs.size >= 100)
      throw new ServiceError(429, "RATE_LIMITED", "已有纠错在进行中或达到本地任务上限，请稍后手动重试");
    const preferences = input.feedbackCapable ? await this.history.preferences(owner).catch(() => undefined) : undefined;
    void this.history.cleanup().catch(() => undefined);
    // Older clients and unsupported editing flows keep the original, history-free behavior.
    const historyEnabled = !!(input.feedbackCapable && preferences?.historyEnabled);
    const id = randomUUID(), abort = new AbortController();
    const job: Job = { owner, key, digest: fingerprint, abort, value: { id, status: "running", createdAt: new Date().toISOString() } };
    this.jobs.set(id, job);
    const timeout = setTimeout(() => {
      job.value = { ...job.value, status: "failed", error: "纠错超时，请手动重试" };
      abort.abort();
    }, this.config.SUIJI_AI_TIMEOUT_SECONDS * 1000);
    timeout.unref();
    void this.lexicons.get(owner).then(async (lexicon) => {
      if (abort.signal.aborted) return;
      let context: CorrectionContext | undefined;
      if (historyEnabled) {
        try {
          context = { examples: await this.history.examples(owner, input.text, input.recordId), records: [] };
          // Ordinary record references remain gated until paired evaluation shows a benefit.
        } catch { context = undefined; }
      }
      if (historyEnabled) {
        const now = await this.history.preferences(owner).catch(() => undefined);
        if (!now?.historyEnabled || now.learningEpoch !== preferences!.learningEpoch) context = undefined;
      }
      if (abort.signal.aborted) return;
      const result = await correctWithCodex(this.config, input.text, lexicon, abort.signal, context);
      if (!abort.signal.aborted) {
        let historyId: string | undefined;
        if (historyEnabled) {
          try { historyId = await this.history.completed(owner, id, input.text, result.correctedText, preferences!.learningEpoch); }
          catch { /* Correction itself remains available. */ }
        }
        job.value = { ...job.value, status: "completed", ...result, historyId, lexiconVersion: lexicon.version };
      }
    }).catch(() => {
      if (!abort.signal.aborted) job.value = { ...job.value, status: "failed", error: "文字纠错未完成，请检查 Codex 登录后手动重试" };
    }).finally(() => { clearTimeout(timeout); job.finished = Date.now(); });
    return job.value;
  }
  get(owner: string, id: string) { this.prune(); const job = this.jobs.get(id); if (!job || job.owner !== owner) throw missing(); return job.value; }
  cancel(owner: string, id: string) {
    const job = this.jobs.get(id); if (!job || job.owner !== owner) throw missing();
    if (job.value.status === "running") { job.value = { ...job.value, status: "cancelled" }; job.abort.abort(); }
    return job.value;
  }
  close() { this.closed = true; for (const job of this.jobs.values()) job.abort.abort(); }
}
