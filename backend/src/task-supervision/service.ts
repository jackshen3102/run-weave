import path from "node:path";
import { randomUUID } from "node:crypto";
import { setting, settingText } from "@runweave/config-node";
import type {
  ChangeSupervisionRequest,
  StartSupervisionRequest,
  SupervisionDiscovery,
  SupervisionHookRequest,
  SupervisionHookResponse,
  SupervisionTarget,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { resolveSupervisionTarget, acceptsStartingHook } from "./target";
import type { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import { checkSupervisionConflicts, supervisionCapability } from "./capability";
import { SupervisionError } from "./errors";
export { SupervisionError } from "./errors";
import {
  buildSupervisionInput,
  digest,
  findFinalReply,
  isSupervisionPrompt,
  messagesFrom,
  initialSupervisionContext,
  refreshReferencedPlans,
  taskCandidates,
} from "./context";
import { TaskSupervisionClassifier } from "./classifier";
import { reconcileDelivery } from "./delivery";
import { applyVerdict } from "./verdict";
import { updateWaitingState } from "./waiting";
import { registerSupervisionConfiguration } from "./configuration";
import { SupervisionJobs } from "./jobs";
import { claimFinal } from "./final-cursor";
import { changeWatch } from "./control";
import { TaskSupervisionStore, type SupervisionJournal } from "./store";

const ALLOW: SupervisionHookResponse = { action: "allow-stop" };
export class TaskSupervisionService {
  private readonly store: TaskSupervisionStore;
  private readonly ready: Promise<void>;
  private journal: SupervisionJournal = {
    version: 1,
    watches: [],
    requests: {},
  };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly jobs = new SupervisionJobs();
  private readonly capabilities = new Map<
    string,
    Pick<
      SupervisionHookRequest,
      "target" | "codexVersion" | "hookVersion" | "executionConfig"
    >
  >();
  private closed = false;
  private maintenance: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly classifier: TaskSupervisionClassifier;
  private readonly checkConflicts = checkSupervisionConflicts;
  private readonly unregisterConfiguration: () => void;
  constructor(
    directory: string,
    private readonly manager: TerminalSessionManager,
    private readonly history: AppServerHistoryGateway,
    classifier?: TaskSupervisionClassifier,
  ) {
    this.unregisterConfiguration = registerSupervisionConfiguration(() => {
      this.jobs.cancelAll();
    });
    this.store = new TaskSupervisionStore(directory);
    this.classifier =
      classifier ??
      new TaskSupervisionClassifier(path.join(directory, "classification"));
    this.ready = this.store.load().then((saved) => {
      this.journal = saved;
    });
    this.timer = setInterval(() => {
      if (!this.maintenance && !this.closed) {
        this.maintenance = this.reconcile()
          .catch(() => undefined)
          .finally(() => {
            this.maintenance = null;
          });
      }
    }, 5000);
    this.timer.unref();
  }
  initialize() {
    return this.ready;
  }
  private cancelJob(id: string) {
    this.jobs.cancel(id);
  }
  private async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ready;
      if (this.closed) throw new SupervisionError("监听服务已关闭。", 503);
      const before = structuredClone(this.journal);
      try {
        const result = await operation();
        await this.store.save(this.journal);
        return structuredClone(result);
      } catch (error) {
        this.journal = before;
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private resolve(terminalSessionId: string, panelId?: string | null) {
    return resolveSupervisionTarget(this.manager, terminalSessionId, panelId);
  }
  private matches(a: SupervisionTarget, b: SupervisionTarget) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  private current(target: SupervisionTarget) {
    try {
      return this.matches(
        this.resolve(target.terminalSessionId, target.panelId).target,
        target,
      );
    } catch {
      return false;
    }
  }
  private capability(target: SupervisionTarget) {
    return supervisionCapability(
      target,
      this.capabilities.get(target.executorGeneration),
    );
  }
  async discover(
    terminalSessionId: string,
    panelId?: string | null,
    expectedThreadId?: string,
  ): Promise<SupervisionDiscovery> {
    await this.ready;
    await this.queue;
    let resolved: ReturnType<TaskSupervisionService["resolve"]>;
    try {
      resolved = this.resolve(terminalSessionId, panelId);
    } catch (error) {
      return {
        target: null,
        watch: null,
        capability: { supported: false, reason: (error as Error).message },
        taskCandidates: [],
      };
    }
    if (expectedThreadId && resolved.target.threadId !== expectedThreadId)
      throw new SupervisionError("会话已切换，请刷新。");
    const watch =
      [...this.journal.watches]
        .reverse()
        .find(
          (w) =>
            this.matches(w.target, resolved.target) &&
            w.pauseReason !== "replaced",
        ) ?? null;
    let candidates: SupervisionDiscovery["taskCandidates"] = [];
    let capability = this.capability(resolved.target);
    try {
      candidates = taskCandidates(
        await this.history.getConversation(resolved.target.threadId),
      );
    } catch (error) {
      capability = {
        ...capability,
        supported: false,
        reason: (error as Error).message,
      };
    }
    return structuredClone({
      target: resolved.target,
      watch,
      capability,
      taskCandidates: candidates,
    });
  }
  async get(watchId: string) {
    await this.ready;
    await this.queue;
    return structuredClone(this.find(watchId));
  }
  private find(id: string): TaskWatch {
    const watch = this.journal.watches.find((w) => w.watchId === id);
    if (!watch) throw new SupervisionError("监控不存在。", 404);
    return watch;
  }
  async start(request: StartSupervisionRequest): Promise<TaskWatch> {
    return this.transaction(async () => {
      const requestDigest = digest(JSON.stringify(request));
      const previousRequest = this.journal.requests[request.requestId];
      if (previousRequest) {
        if (previousRequest.digest !== requestDigest)
          throw new SupervisionError("requestId 已用于不同请求。");
        return this.find(previousRequest.watchId);
      }
      const resolved = this.resolve(
        request.target.terminalSessionId,
        request.target.panelId,
      );
      if (!this.matches(resolved.target, request.target))
        throw new SupervisionError("任务或执行器已切换。");
      const capability = this.capability(request.target);
      if (!capability.supported)
        throw new SupervisionError(capability.reason!, 422);
      await this.checkConflicts(
        request.target,
        resolved.root,
        this.capabilities.get(request.target.executorGeneration)
          ?.executionConfig,
      );
      const existing = [...this.journal.watches]
        .reverse()
        .find(
          (w) =>
            this.matches(w.target, request.target) &&
            w.pauseReason !== "replaced",
        );
      if (
        existing &&
        (request.replacesWatchId !== existing.watchId ||
          request.expectedRevision !== existing.revision)
      )
        throw new SupervisionError("当前任务已有监控，请确认重新开启一轮。");
      if (!existing && request.replacesWatchId)
        throw new SupervisionError("旧监控已变化，请刷新。");
      const source = await this.history.getConversation(
        request.target.threadId,
      );
      const { task, plans } = await initialSupervisionContext(
        resolved.root,
        source,
        request,
      );
      if (
        !this.current(request.target) ||
        !this.capability(request.target).supported
      )
        throw new SupervisionError("任务、执行器或监控能力已变化，请刷新。");
      const now = new Date().toISOString();
      if (existing) {
        this.cancelJob(existing.watchId);
        existing.status = "paused";
        existing.pauseReason = "replaced";
        existing.revision++;
        existing.updatedAt = now;
      }
      const watch: TaskWatch = {
        watchId: randomUUID(),
        target: request.target,
        taskStartMessageId: task.id,
        task,
        goal: request.goal,
        plans,
        revision: 1,
        contextRevision: 1,
        status: "watching",
        outcome: null,
        continuationLimit: 3,
        continuationCount: 0,
        decisions: [],
        createdAt: now,
        updatedAt: now,
      };
      this.journal.watches.push(watch);
      this.journal.requests[request.requestId] = {
        digest: requestDigest,
        watchId: watch.watchId,
      };
      return watch;
    });
  }
  async change(id: string, request: ChangeSupervisionRequest) {
    return this.transaction(async () => {
      const watch = this.find(id);
      await changeWatch(
        watch,
        request,
        () => this.current(watch.target),
        () => this.history.getConversation(watch.target.threadId),
      );
      this.cancelJob(id);
      return watch;
    });
  }
  async hook(
    request: SupervisionHookRequest,
  ): Promise<SupervisionHookResponse> {
    await this.ready;
    if (this.closed) return ALLOW;
    if (
      !this.current(request.target) &&
      !(
        request.event === "SessionStart" &&
        acceptsStartingHook(this.manager, request.target)
      )
    )
      return ALLOW;
    if (request.codexVersion)
      this.capabilities.set(request.target.executorGeneration, {
        target: request.target,
        codexVersion: request.codexVersion,
        hookVersion: request.hookVersion,
        executionConfig: request.executionConfig,
      });
    if (!this.current(request.target)) return ALLOW;
    const watch = [...this.journal.watches]
      .reverse()
      .find(
        (w) =>
          this.matches(w.target, request.target) &&
          w.pauseReason !== "replaced",
      );
    if (!watch) return ALLOW;
    if (
      ["PermissionRequest", "PreToolUse", "PostToolUse"].includes(request.event)
    ) {
      await this.transaction(() =>
        updateWaitingState(this.find(watch.watchId), request),
      );
      return ALLOW;
    }
    if (request.event === "Interrupt" || request.event === "UserPromptSubmit") {
      if (
        request.event === "UserPromptSubmit" &&
        isSupervisionPrompt(request.prompt ?? "")
      )
        return ALLOW;
      this.cancelJob(watch.watchId);
      await this.transaction(() => {
        const current = this.find(watch.watchId);
        current.revision++;
        current.contextRevision++;
        if (request.event === "Interrupt") {
          current.status = "paused";
          current.pauseReason = "interrupted";
        } else if (current.status === "classifying")
          current.status = "watching";
        current.updatedAt = new Date().toISOString();
      });
      return ALLOW;
    }
    if (
      request.event !== "Stop" ||
      !request.rawTurnId ||
      !request.reply?.trim() ||
      request.deadline <= Date.now() + 2000 ||
      !this.capability(request.target).supported
    )
      return ALLOW;
    const key = `${request.rawTurnId}:${digest(request.reply)}:${request.deadline}`;
    const job = this.jobs.get(watch.watchId);
    // An in-flight duplicate must not return the same continuation twice.
    if (job) return ALLOW;
    const controller = new AbortController();
    const promise = this.processStop(watch.watchId, request, controller, key);
    const pending = { controller, promise };
    this.jobs.add(watch.watchId, pending);
    try {
      return await promise;
    } finally {
      this.jobs.finish(watch.watchId, pending);
    }
  }
  private async processStop(
    id: string,
    request: SupervisionHookRequest,
    controller: AbortController,
    key: string,
  ): Promise<SupervisionHookResponse> {
    let revision: number | undefined;
    try {
      const source = await this.history.getConversation(
        request.target.threadId,
      );
      const sourceMessages = messagesFrom(source);
      const native = findFinalReply(
        sourceMessages,
        request.rawTurnId!,
        request.reply!,
      );
      if (!native)
        throw new Error("无法定位本轮最终回复来源；等待会话写入后恢复监听。");
      const snapshot = await this.transaction(() => {
        const watch = this.find(id);
        if (controller.signal.aborted) return null;
        if (!this.current(watch.target)) {
          watch.status = "paused";
          watch.pauseReason = "target_changed";
          watch.revision++;
          return null;
        }
        reconcileDelivery(watch, sourceMessages, 0);
        if (
          watch.decisions.some(
            (d) =>
              `${d.rawTurnId}:${d.replyDigest}:${d.deliveryDeadline}` === key ||
              (native && d.input.currentReply.id === native.id),
          ) ||
          !claimFinal(watch, sourceMessages, native)
        )
          return null;
        watch.revision++;
        watch.updatedAt = new Date().toISOString();
        if (watch.status !== "watching") return null;
        delete watch.waitingFor;
        watch.status = "classifying";
        delete watch.error;
        return watch;
      });
      if (!snapshot) return ALLOW;
      revision = snapshot.revision;
      await refreshReferencedPlans(
        this.resolve(request.target.terminalSessionId, request.target.panelId)
          .root,
        snapshot,
        sourceMessages,
      );
      if (request.executionConfig)
        await this.checkConflicts(
          request.target,
          request.executionConfig.cwd,
          request.executionConfig,
        );
      const input = buildSupervisionInput(snapshot, source, {
        id: native.id,
        role: "assistant",
        text: request.reply!,
        rawTurnId: request.rawTurnId!,
        phase: "final",
        createdAt: native.createdAt ?? new Date().toISOString(),
      });
      const timeoutMs = Math.min(
        Number(
          setting("backend.taskSupervision.classificationTimeoutMs", 90_000),
        ),
        request.deadline - Date.now() - 5000,
        90_000,
      );
      if (
        timeoutMs <= 0 ||
        controller.signal.aborted ||
        !this.current(request.target)
      )
        throw new Error("分类截止时间已过或已取消。");
      const result = await this.classifier.run(input, {
        model:
          settingText("backend.taskSupervision.model") ??
          request.executionModel,
        timeoutMs,
        signal: controller.signal,
      });
      return await this.transaction((): SupervisionHookResponse => {
        const watch = this.find(id);
        if (watch.revision !== revision || watch.status !== "classifying")
          return ALLOW;
        if (!this.current(watch.target)) {
          watch.status = "paused";
          watch.pauseReason = "target_changed";
          watch.revision++;
          return ALLOW;
        }
        if (
          controller.signal.aborted ||
          !this.capability(watch.target).supported ||
          Date.now() >= request.deadline - 2000
        )
          throw new Error("分类已取消、监控配置已关闭或结果已过期。");
        const decision = {
          ...result,
          codexVersion: request.codexVersion,
          decisionId: randomUUID(),
          rawTurnId: request.rawTurnId!,
          replyDigest: digest(request.reply!),
          contextRevision: watch.contextRevision,
          createdAt: new Date().toISOString(),
          input,
          delivery: "not_requested" as "not_requested" | "offered",
          deliveryDeadline: request.deadline,
        };
        return applyVerdict(watch, decision);
      });
    } catch (error) {
      await this.transaction(() => {
        const watch = this.find(id);
        if (
          revision === undefined
            ? watch.status !== "watching" || controller.signal.aborted
            : watch.revision !== revision || watch.status !== "classifying"
        )
          return;
        watch.status = this.current(watch.target) ? "error" : "paused";
        if (watch.status === "paused") watch.pauseReason = "target_changed";
        watch.revision++;
        watch.error = controller.signal.aborted
          ? "分类已取消；恢复后等待新的最终回复。"
          : (error instanceof Error ? error.message : "分类失败").slice(0, 500);
        watch.updatedAt = new Date().toISOString();
      }).catch(() => undefined);
      return ALLOW;
    }
  }
  async validOffer(
    id: string,
    decisionId: string,
    revision: number,
  ): Promise<boolean> {
    await this.ready;
    await this.queue;
    const watch = this.find(id);
    return (
      !this.closed &&
      watch.status === "watching" &&
      watch.revision === revision &&
      this.current(watch.target) &&
      this.capability(watch.target).supported &&
      watch.decisions.some(
        (d) =>
          d.decisionId === decisionId &&
          d.delivery === "offered" &&
          Date.now() < d.deliveryDeadline - 500,
      )
    );
  }
  async dispose() {
    this.closed = true;
    this.unregisterConfiguration();
    clearInterval(this.timer);
    this.jobs.cancelAll();
    await this.jobs.drain();
    await this.queue;
    await this.maintenance;
  }
  private async reconcile() {
    await this.ready;
    const candidates = this.journal.watches.filter(
      (w) =>
        w.status === "watching" ||
        w.decisions.some((d) => ["offered", "unknown"].includes(d.delivery)),
    );
    for (const saved of candidates) {
      if (this.closed) return;
      if (!this.current(saved.target)) {
        this.cancelJob(saved.watchId);
        await this.transaction(() => {
          const w = this.find(saved.watchId);
          if (["watching", "classifying"].includes(w.status)) {
            w.status = "paused";
            w.pauseReason = "target_changed";
            w.revision++;
            w.updatedAt = new Date().toISOString();
          }
        });
        continue;
      }
      if (
        !saved.decisions.some((d) =>
          ["offered", "unknown"].includes(d.delivery),
        )
      )
        continue;
      const source = await this.history
        .getConversation(saved.target.threadId)
        .catch(() => null);
      const messages =
        source && source.availability === "available"
          ? source.turns.flatMap((t) => t.messages)
          : [];
      await this.transaction(() => {
        const w = this.find(saved.watchId);
        reconcileDelivery(w, messages);
      });
    }
  }
}
