import { randomUUID } from "node:crypto";
import { chmod, realpath } from "node:fs/promises";
import path from "node:path";
import type { CodeReviewDetail, CodeReviewPage, CodeReviewRun, CreateCodeReviewRequest } from "@runweave/shared/terminal/code-review";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalSessionCreationOptions } from "../application/create-session";
import type { TerminalTaskService } from "../tasks/service";
import { atomicJson, CodeReviewError, CodeReviewStore, readOwnedFile, type ReviewRecord } from "./store";
import { captureReviewSnapshot, reviewDigest } from "./snapshot";
import { saveReviewReport } from "./report";
import { buildCodeReviewPrompt } from "./prompt";
import { deliverCodeReview, readSourceBinding } from "./delivery";
import { prepareReviewerLaunch } from "./hooks";

const active = (run: CodeReviewRun) => ["preparing", "starting", "reviewing"].includes(run.phase);
/** One Backend owner, serial ticks and request mutations. UI has no scheduling role. */
export class CodeReviewService {
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: (() => void) | undefined;
  private closing = false;
  private started = false;
  private queued = false;
  constructor(private readonly store: CodeReviewStore, private readonly manager: TerminalSessionManager,
    private readonly tasks: TerminalTaskService, private readonly options: TerminalSessionCreationOptions) {}
  async initialize() {
    await this.store.initialize();
    // A null attempt proves no PTY write was started. Requeue saved reports
    // rejected by the old source-binding checks, without replaying uncertain I/O.
    for (const record of this.store.records.values()) {
      if (record.run.caseStatus !== "closed" && record.run.phase === "completed" && record.run.reportId && !record.delivery.attemptedAt &&
          ["unavailable", "target_changed"].includes(record.run.delivery)) {
        record.run.delivery = "pending"; record.run.deliveryError = null;
      }
    }
    await this.store.save();
  }
  start() {
    if (this.started || this.closing) return;
    this.started = true;
    this.unlisten = this.options.terminalEventService?.subscribe(() => this.wake());
    this.schedule(); this.wake();
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new CodeReviewError(503, "service_closed", "Review 服务正在关闭"));
    const work = this.tail.catch(() => undefined).then(action);
    this.tail = work;
    return work;
  }
  private schedule() {
    if (this.closing) return;
    this.timer = setTimeout(() => { this.wake(); this.schedule(); }, 5000);
    this.timer.unref();
  }
  private wake() {
    if (this.closing || this.queued) return;
    this.queued = true;
    void this.exclusive(async () => {
      try {
        for (const record of this.store.records.values()) {
          if (this.closing) break;
          if (record.run.caseStatus === "closed") continue;
          if (!active(record.run) && record.run.delivery !== "pending") continue;
          try { await this.advance(record); }
          catch (error) {
            record.run.phase = "blocked";
            record.run.error = { code: error instanceof CodeReviewError ? error.code : "review_unavailable",
              message: error instanceof CodeReviewError ? error.message : "Review 自动推进失败，请查看评审终端" };
            await this.touch(record);
          }
        }
      } finally { this.queued = false; }
    }).catch(() => { this.queued = false; });
  }
  private async touch(record: ReviewRecord) {
    record.run.updatedAt = new Date().toISOString(); await this.store.save();
  }
  private get(id: string) {
    const record = this.store.records.get(id);
    if (!record) throw new CodeReviewError(404, "review_not_found", "Review 不存在");
    return record;
  }
  create(terminalId: string, request: CreateCodeReviewRequest): Promise<CodeReviewRun> {
    return this.exclusive(async () => {
      this.store.assertWritable();
      const old = [...this.store.records.values()].find((record) => record.requests.some((item) => item.terminalId === terminalId && item.request.requestId === request.requestId));
      if (old) {
        const entry = old.requests.find((item) => item.terminalId === terminalId && item.request.requestId === request.requestId)!;
        if (reviewDigest(entry.request) !== reviewDigest(request)) throw new CodeReviewError(409, "request_conflict", "同一请求编号的参数已变化");
        return structuredClone(old.run);
      }
      let source;
      try { source = readSourceBinding(this.manager, terminalId); }
      catch (error) { throw new CodeReviewError(409, "target_changed", String(error)); }
      try { source.rootPath = await realpath(source.rootPath); }
      catch { throw new CodeReviewError(400, "workspace_unavailable", "工作区路径无效"); }
      const previous = [...this.store.records.values()].reverse().find((record) => record.source.terminalId === terminalId);
      const continuing = previous?.run.caseStatus === "open" && previous.source.projectId === source.projectId && previous.source.rootPath === source.rootPath;
      if (continuing && active(previous.run)) {
        previous.requests.push({ terminalId, request }); await this.touch(previous); return structuredClone(previous.run);
      }
      if (continuing && ["pending", "writing"].includes(previous.run.delivery))
        throw new CodeReviewError(409, "delivery_pending", "本轮结果尚在回传，请等待回传结束后复审");
      const id = randomUUID(); const now = new Date().toISOString();
      const candidate = continuing && previous.reviewerThreadId && previous.run.reviewerTerminalId
        ? await this.tasks.observe(previous.reviewerTaskId).catch(() => null) : null;
      // A user request authorizes another review, not taking control back from a
      // human or resuming a lost executor. Keep the case, use a fresh Reviewer then.
      const reuse = candidate?.availability === "available" && candidate.task.phase === "ready" && candidate.task.control === "supervisor" &&
        candidate.task.threadId === previous?.reviewerThreadId && candidate.task.terminalSessionId === previous?.run.reviewerTerminalId &&
        candidate.terminalState?.state === "agent_idle";
      const record: ReviewRecord = { source, requests: [{ terminalId, request }], snapshotId: null,
        reviewerTaskId: reuse ? previous.reviewerTaskId : `code-review:${id}`, reviewerThreadId: reuse ? previous.reviewerThreadId : null,
        startedAt: Date.now(), dispatchId: `review:${id}`, recovered: false,
        delivery: { deliveryId: `code-review-result:${id}`, reportHash: null, attemptedAt: null },
        run: { reviewId: id, caseId: continuing ? previous.run.caseId : id, caseStatus: "open", round: continuing ? previous.run.round + 1 : 1,
          requestId: request.requestId, projectId: source.projectId, phase: "preparing", createdAt: now, updatedAt: now,
          reviewerTerminalId: reuse ? previous.run.reviewerTerminalId : null, reviewerPanelId: reuse ? previous.run.reviewerPanelId : null,
          reportId: null, stale: false, delivery: "not_ready", error: null,
          deliveryError: null, summary: null, findingCount: null } };
      this.store.records.set(id, record);
      await this.touch(record); // durable creation intent precedes snapshot or terminal creation
      await this.store.prepare(id);
      this.wake();
      return structuredClone(record.run);
    });
  }
  close(id: string): Promise<CodeReviewRun> {
    return this.exclusive(async () => {
      this.store.assertWritable();
      const record = this.get(id);
      const latest = [...this.store.records.values()].reverse().find((item) => item.run.caseId === record.run.caseId)!;
      if (latest.run.caseStatus !== "open") return structuredClone(latest.run);
      if (latest !== record) throw new CodeReviewError(409, "review_changed", "已有更新的复审，请刷新后结束事项");
      if (active(record.run) || ["pending", "writing"].includes(record.run.delivery))
        throw new CodeReviewError(409, "review_busy", "请等待本轮审查和回传结束后关闭事项");
      for (const item of this.store.records.values()) {
        if (item.run.caseId === record.run.caseId) item.run.caseStatus = "closed";
      }
      await this.touch(record);
      return structuredClone(record.run);
    });
  }
  list(terminalId: string, before?: string): CodeReviewPage {
    const records = [...this.store.records.values()].filter((record) => record.source.terminalId === terminalId)
      .reverse();
    const start = before ? records.findIndex((record) => record.run.reviewId === before) + 1 : 0;
    if (before && start === 0) throw new CodeReviewError(400, "cursor_invalid", "Review 游标无效");
    const page = records.slice(start, start + 20);
    let target: CodeReviewPage["target"] = null;
    try {
      const source = readSourceBinding(this.manager, terminalId);
      // Compatibility for older clients. New clients address only the terminal URL.
      target = { panelId: null, expectedTarget: { projectId: source.projectId, provider: null, threadId: null } };
    } catch { /* Saved records remain readable after the source is closed. */ }
    return { target, runs: structuredClone(page.map((record) => record.run)), before: records.length > start + 20 ? page.at(-1)!.run.reviewId : null };
  }
  async detail(id: string): Promise<CodeReviewDetail> {
    const record = this.get(id);
    const snapshot = record.snapshotId ? await this.store.snapshot(id) : null;
    return { run: structuredClone(record.run), snapshot: snapshot ? { ...snapshot,
      entries: snapshot.entries.map((entry) => ({ path: entry.path, oldPath: entry.oldPath, status: entry.status, changeKind: entry.changeKind, omission: entry.omission })) } : null,
      report: record.run.reportId ? await this.store.report(id) : null };
  }
  async artifact(id: string, artifactId: string) {
    const record = this.get(id);
    if (!record.run.reportId) throw new CodeReviewError(404, "artifact_not_found", "报告未保存");
    const report = await this.store.report(id);
    const artifact = report.artifacts.find((item) => item.artifactId === artifactId);
    if (!artifact) throw new CodeReviewError(404, "artifact_not_found", "产物不存在");
    return { bytes: await readOwnedFile(path.join(this.store.saved(id), "artifacts"), artifact.artifactId, 20 * 1024 * 1024), mimeType: artifact.mimeType };
  }
  private async advance(record: ReviewRecord) {
    const { run } = record; const id = run.reviewId;
    if (run.phase === "completed") {
      if (record.recovered && record.delivery.attemptedAt) {
        run.delivery = "unknown"; run.deliveryError = "Backend 重启后未恢复自动回传，请查看已保存报告";
        await this.touch(record); return;
      }
      await deliverCodeReview(this.store, record, await this.store.report(id), this.manager, this.options); return;
    }
    if (run.phase === "preparing") {
      await this.store.prepare(id);
      if (!record.snapshotId) {
        const snapshot = await captureReviewSnapshot(record.source.projectId, record.source.rootPath);
        if (!snapshot.entries.length) throw new CodeReviewError(409, "no_changes", "当前工作区没有待审查的改动");
        await atomicJson(path.join(this.store.input(id), "snapshot.json"), snapshot);
        await chmod(path.join(this.store.input(id), "snapshot.json"), 0o400);
        record.snapshotId = snapshot.snapshotId; await this.touch(record);
        await chmod(this.store.input(id), 0o500);
        if (snapshot.entries.every((entry) => entry.omission)) throw new CodeReviewError(422, "no_reviewable_changes", "全部变更均不可读取，覆盖缺口已保存");
      }
      if (record.recovered && !this.tasks.list().some((task) => task.taskId === record.reviewerTaskId) && !run.reviewerTerminalId) {
        // The durable task ledger proves that no terminal/start intent existed.
        record.recovered = false;
      }
      if (record.reviewerThreadId) {
        // Explicit re-review: retain the case's executor, freeze a new snapshot and
        // dispatch a new turn. Never restart/resume an executor or overwrite a report.
        run.phase = "starting"; record.startedAt = Date.now(); await this.touch(record);
      } else {
        const task = await this.tasks.create({ taskId: record.reviewerTaskId, projectId: record.source.projectId,
          cwd: record.source.rootPath, goal: `Independent code review ${id}` });
        run.reviewerTerminalId = task.terminalSessionId; run.reviewerPanelId = task.panelId;
        run.phase = "starting"; record.startedAt = Date.now(); await this.touch(record);
        if (task.terminalSessionId) await this.manager.updateSessionAlias(task.terminalSessionId, `Review · ${id.slice(0, 8)}`);
        if (record.recovered || task.phase !== "created" || task.control !== "supervisor")
          throw new CodeReviewError(409, "restart_requires_human", "已有终端仅恢复观察，不自动重启 Reviewer");
        await this.tasks.start(record.reviewerTaskId, { expectedRevision: task.revision }, await prepareReviewerLaunch(record.source.rootPath));
      }
    }
    if (Date.now() - record.startedAt > (run.phase === "starting" ? 120_000 : 30 * 60_000))
      throw new CodeReviewError(409, "review_timeout", "自动推进已超时，Reviewer 未被强制停止，请查看评审终端");
    const observation = await this.tasks.observe(record.reviewerTaskId);
    const task = observation.task;
    if (["target_changed", "terminal_unavailable"].includes(observation.availability))
      throw new CodeReviewError(409, observation.availability, "Reviewer 身份已变化或终端不可用");
    if (task.phase === "unavailable") throw new CodeReviewError(503, "reviewer_unavailable", "Reviewer 启动服务不可用");
    if (run.phase === "starting" && task.phase === "ready" && observation.availability === "available") {
      if (record.reviewerThreadId && record.reviewerThreadId !== task.threadId)
        throw new CodeReviewError(409, "target_changed", "复审 Reviewer 的原会话已变化");
      const marker = `RW_TASK_READY_${reviewDigest(task.taskId).slice(0, 20)}`;
      const bootstrap = observation.turns.find((turn) => turn.messages.some((message) => message.role === "user" && message.text.includes(marker)));
      if (!bootstrap || bootstrap.status !== "completed" || bootstrap.itemsView !== "full" || observation.terminalState?.state !== "agent_idle" ||
          !bootstrap.messages.some((message) => message.role === "assistant" && message.phase === "final" && message.text.trim())) return;
      if (record.recovered || task.control !== "supervisor") throw new CodeReviewError(409, "human_control", "Reviewer 已由人工接管，不自动派发");
      const snapshot = await this.store.snapshot(id);
      record.reviewerThreadId = task.threadId;
      run.phase = "reviewing"; record.startedAt = Date.now(); await this.touch(record);
      await this.tasks.send(task.taskId, { expectedRevision: task.revision, dispatchId: record.dispatchId, delivery: "when_idle",
        text: buildCodeReviewPrompt({ reviewId: id, round: run.round, snapshot, inputPath: path.join(this.store.input(id), "snapshot.json"), outputPath: this.store.output(id) }) });
      return;
    }
    if (run.phase !== "reviewing" || observation.availability !== "available") return;
    if (task.threadId !== record.reviewerThreadId) throw new CodeReviewError(409, "target_changed", "Reviewer thread 已变化");
    const dispatch = task.dispatches.find((item) => item.dispatchId === record.dispatchId);
    if (!dispatch) throw new CodeReviewError(409, "dispatch_unknown", "派发阶段不确定，不自动重放");
    if (dispatch.status === "delivery_unknown" && record.recovered)
      throw new CodeReviewError(409, "dispatch_unknown", "重启前派发结果不确定，不自动重放");
    const turn = observation.turns.find((item) => item.id === dispatch.turnId);
    // Codex thread/read can temporarily label an unfinished live turn interrupted.
    // The Stop Hook can report idle before the native history has flushed its end.
    if (!turn || !turn.completedAt || turn.itemsView !== "full" || observation.partial || observation.terminalState?.state !== "agent_idle" || turn.status === "inProgress") return;
    if (turn.status !== "completed") {
      run.phase = turn.status === "interrupted" ? "cancelled" : "failed";
      run.error = { code: `reviewer_${turn.status}`, message: "Reviewer 未正常完成，部分证据保留在评审终端" };
      await this.touch(record); return;
    }
    const finals = turn.messages.filter((message) => message.role === "assistant" && message.phase === "final" && message.text.trim());
    if (finals.length !== 1) throw new CodeReviewError(422, "final_unavailable", "缺少完整且唯一的原生 final");
    const snapshot = await this.store.snapshot(id);
    const report = await saveReviewReport(this.store, id, snapshot, finals[0]!.text);
    try { run.stale = (await captureReviewSnapshot(record.source.projectId, record.source.rootPath)).fingerprint !== snapshot.fingerprint; }
    catch { run.stale = true; }
    run.reportId = id; run.summary = report.summary; run.findingCount = report.findings.length;
    const unverified = !report.findings.length && !report.coverageComplete;
    run.phase = unverified ? "blocked" : "completed"; run.delivery = report.findings.length ? "pending" : "skipped";
    run.error = unverified ? { code: "review_incomplete", message: "验收阻塞：存在覆盖或复现缺口" } : null;
    for (const item of this.store.records.values()) {
      if (item.run.caseId === run.caseId) item.run.caseStatus = !report.findings.length && !unverified ? "passed" : "open";
    }
    record.delivery.reportHash = reviewDigest(report);
    await this.touch(record);
    // Findings are delivered on a following serial tick after the report is durable.
  }
  async dispose() {
    this.closing = true; if (this.timer) clearTimeout(this.timer); this.unlisten?.();
    await this.tail.catch(() => undefined); await this.store.close();
  }
}
