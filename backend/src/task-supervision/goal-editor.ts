import { randomUUID } from "node:crypto";
import type {
  PreviewSupervisionGoalRequest,
  SupervisionGoalDetail,
  SupervisionGoalPreview,
  SupervisionTarget,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import type { SupervisionConversationResponse } from "@runweave/shared/terminal/conversation";
import { digest, messagesFrom, taskCandidates } from "./context";
import { SupervisionError } from "./errors";
import {
  manualGoal,
  prepareGoalEvidence,
  type GoalEvidence,
  type GoalResolution,
} from "./goals";
import { sameTarget, synchronizeContext } from "./synchronization";

interface GoalEditorOperations {
  get: (id: string) => Promise<TaskWatch>;
  find: (id: string) => TaskWatch;
  read: (
    id: string,
    thread: string,
  ) => Promise<SupervisionConversationResponse>;
  current: (target: SupervisionTarget) => boolean;
  root: (target: SupervisionTarget) => string;
  inputRevision: (target: SupervisionTarget) => object;
  generate: (
    watch: TaskWatch,
    evidence: GoalEvidence,
    signal: AbortSignal,
  ) => Promise<GoalResolution>;
  transaction: <T>(operation: () => T | Promise<T>) => Promise<T>;
  archive: (id: string, detail: SupervisionGoalDetail) => void;
  archived: (id: string, revisionId: string) => SupervisionGoalDetail | null;
  applied: (id: string, previewId: string) => boolean;
  recordApplication: (id: string, previewId: string) => void;
  cancel: (id: string) => void;
  replay: (watch: TaskWatch, source: SupervisionConversationResponse) => void;
}
const fingerprint = (source: SupervisionConversationResponse) =>
  digest(JSON.stringify(messagesFrom(source)));
const detail = (result: GoalResolution): SupervisionGoalDetail => ({
  goal: result.goal,
  messages: result.messages,
  plans: result.plans,
  reason: result.reason,
});

/** Preview is ephemeral; only adoption archives a version in the watch transaction. */
export class SupervisionGoalEditor {
  private readonly previews = new Map<
    string,
    {
      watchId: string;
      preview: SupervisionGoalPreview;
      fingerprint: string;
      sourceVersion?: string;
      inputRevision: object;
    }
  >();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly operations: GoalEditorOperations) {}

  preview(
    id: string,
    request: PreviewSupervisionGoalRequest,
    signal?: AbortSignal,
  ) {
    this.controllers.get(id)?.abort();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const combined = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    const job = this.buildPreview(id, request, combined).finally(() => {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      this.pending.delete(job);
    });
    this.pending.add(job);
    return job;
  }
  private async buildPreview(
    id: string,
    request: PreviewSupervisionGoalRequest,
    signal: AbortSignal,
  ) {
    const ops = this.operations;
    const watch = await ops.get(id);
    if (
      this.closed ||
      signal.aborted ||
      watch.revision !== request.expectedRevision ||
      !ops.current(watch.target)
    )
      throw new SupervisionError("任务已变化，请重新读取后生成。");
    const inputRevision = ops.inputRevision(watch.target);
    const source = await ops.read(id, watch.target.threadId);
    const previous =
      watch.goalDefinition && ops.archived(id, watch.goalDefinition.revisionId);
    const evidence = await prepareGoalEvidence(
      watch,
      source,
      ops.root(watch.target),
      previous ? previous.plans : watch.plans,
    );
    const result = request.content
      ? manualGoal(watch, evidence, request.content)
      : await ops.generate(watch, evidence, signal);
    const current = await ops.get(id);
    if (
      this.closed ||
      signal.aborted ||
      current.revision !== watch.revision ||
      !ops.current(watch.target) ||
      !sameTarget(current.target, watch.target) ||
      ops.inputRevision(watch.target) !== inputRevision
    )
      throw new SupervisionError("生成期间任务或输入已变化，请重新生成。");
    const fresh = await ops.read(id, watch.target.threadId);
    if (
      fingerprint(fresh) !== fingerprint(source) ||
      source.sourceVersion !== fresh.sourceVersion
    )
      throw new SupervisionError("生成期间对话已变化，请重新生成。");
    const previewId = randomUUID();
    if (result.changed) result.goal.revisionId = previewId;
    const preview: SupervisionGoalPreview = {
      ...detail(result),
      previewId,
      expectedRevision: watch.revision,
      target: watch.target,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      changed: result.changed,
      needsClarification: result.needsClarification,
      requiresAdoption:
        result.changed ||
        watch.goalState !== "ready" ||
        watch.goalCheckedMessageId !== result.checkedMessageId,
    };
    for (const [key, value] of this.previews)
      if (
        Date.parse(value.preview.expiresAt) < Date.now() ||
        value.watchId === id
      )
        this.previews.delete(key);
    while (this.previews.size >= 20)
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, {
      watchId: id,
      preview,
      fingerprint: fingerprint(source),
      sourceVersion: source.sourceVersion,
      inputRevision,
    });
    return preview;
  }
  async apply(id: string, previewId: string) {
    const ops = this.operations;
    await ops.get(id);
    // Adoption receipts also cover unchanged goals revalidated after an error.
    if (ops.applied(id, previewId)) return ops.get(id);
    const entry = this.previews.get(previewId);
    if (
      this.closed ||
      !entry ||
      entry.watchId !== id ||
      Date.parse(entry.preview.expiresAt) < Date.now()
    )
      throw new SupervisionError("目标预览已过期，请重新生成或编辑。");
    const { preview } = entry;
    if (preview.needsClarification)
      throw new SupervisionError("必要来源不足，请明确目标后再采用。", 422);
    const source = await ops.read(id, preview.target.threadId);
    let adopted = false;
    const updated = await ops.transaction(() => {
      const watch = ops.find(id);
      if (ops.applied(id, previewId)) return watch;
      if (
        !ops.current(preview.target) ||
        !sameTarget(watch.target, preview.target) ||
        watch.revision !== preview.expectedRevision ||
        ops.inputRevision(preview.target) !== entry.inputRevision ||
        source.sourceVersion !== entry.sourceVersion ||
        fingerprint(source) !== entry.fingerprint
      )
        throw new SupervisionError(
          "任务、对话或输入已变化，未采用旧预览；请重新生成。",
        );
      if (!preview.requiresAdoption) {
        ops.recordApplication(id, previewId);
        return watch;
      }
      if (
        watch.decisions.some(
          (d) =>
            d.contextRevision === watch.contextRevision &&
            ["offered", "unknown"].includes(d.delivery),
        )
      )
        throw new SupervisionError(
          "有续接尚未确认接收，请先在原终端核对，暂不能重判旧回复。",
        );
      ops.cancel(id);
      synchronizeContext(watch, taskCandidates(source));
      watch.goalDefinition = preview.goal;
      watch.goal = preview.goal.objective;
      delete watch.goalOverride;
      watch.goalState = "ready";
      watch.goalReason = preview.reason;
      watch.goalCheckedMessageId = taskCandidates(source).at(-1)?.id;
      watch.sourceVersion = source.sourceVersion;
      watch.contextRevision++;
      watch.revision++;
      watch.outcome = null;
      delete watch.lastFinalMessageId;
      delete watch.pendingReply;
      delete watch.error;
      // Editing a goal does not reset quota, interruptions, or the terminal switch.
      if (watch.status === "classifying" || watch.status === "error")
        watch.status = watch.enabled ? "watching" : "paused";
      watch.updatedAt = new Date().toISOString();
      if (preview.changed)
        ops.archive(id, {
          goal: preview.goal,
          messages: preview.messages,
          plans: preview.plans,
          reason: preview.reason,
        });
      ops.recordApplication(id, previewId);
      adopted = true;
      return watch;
    });
    if (adopted) ops.replay(updated, source);
    return updated;
  }
  cancel(id: string) {
    this.controllers.get(id)?.abort();
  }
  async dispose() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.pending);
    this.previews.clear();
  }
}
