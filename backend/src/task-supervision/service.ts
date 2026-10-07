import path from "node:path";
import { randomUUID } from "node:crypto";
import { setting, settingText } from "@runweave/config-node";
import type { AppServerEventEnvelope } from "@runweave/shared/app-server-events";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
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
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import { completionReply, supervisionEvent, type ReplyEvent } from "./events";
import { updateWaitingState } from "./waiting";
import { hasPendingTerminalInput, terminalInputAdmission } from "../terminal/runtime/input-admission";
import { resolveSupervisionTarget } from "./target";
import { SupervisionError } from "./errors";
export { SupervisionError } from "./errors";
import {
  buildSupervisionInput,
  digest,
  messagesFrom,
  refreshReferencedPlans,
  taskCandidates,
} from "./context";
import { TaskSupervisionClassifier } from "./classifier";
import { reconcileDelivery, readPendingDeliveries } from "./delivery";
import { applyVerdict } from "./verdict";
import { SupervisionJobs } from "./jobs";
import { TaskSupervisionStore, type SupervisionJournal } from "./store";

const ALLOW: SupervisionHookResponse = { action: "allow-stop" };
type ContinueOffer = Extract<
  SupervisionHookResponse,
  { action: "request-continuation" }
>;

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
  private readonly eventQueues = new Map<string, Promise<void>>();
  private closed = false;
  private unsubscribe?: () => void;
  private deliver?: (
    target: SupervisionTarget,
    offer: ContinueOffer,
    valid: () => void,
  ) => Promise<void>;
  private maintenance: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly classifier: TaskSupervisionClassifier;

  constructor(
    directory: string,
    private readonly manager: TerminalSessionManager,
    private readonly history: AppServerHistoryGateway,
    classifier?: TaskSupervisionClassifier,
  ) {
    this.store = new TaskSupervisionStore(directory);
    this.classifier =
      classifier ??
      new TaskSupervisionClassifier(path.join(directory, "classification"));
    this.ready = this.store.load().then((saved) => {
      this.journal = saved;
    });
    this.timer = setInterval(() => {
      if (!this.maintenance && !this.closed)
        this.maintenance = this.reconcile()
          .catch(() => undefined)
          .finally(() => {
            this.maintenance = null;
          });
    }, 5000);
    this.timer.unref();
  }
  initialize() {
    return this.ready;
  }

  /** Subscribe once to the same completion stream used by notifications, regardless of switches. */
  attach(
    events: TerminalEventService,
    deliver: NonNullable<TaskSupervisionService["deliver"]>,
  ) {
    this.deliver = deliver;
    this.unsubscribe = events.subscribe((event) => {
      if (event.kind === "completion") this.completed(event);
      else if (event.kind === "terminal_session_deleted") {
        const watch = this.forTerminal(event.terminalSessionId);
        if (watch) this.jobs.cancel(watch.watchId);
      }
    });
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
  private forTerminal(id: string) {
    return [...this.journal.watches]
      .reverse()
      .find(
        (w) =>
          w.target.terminalSessionId === id && w.pauseReason !== "replaced",
      );
  }
  private find(id: string) {
    const watch = this.journal.watches.find((w) => w.watchId === id);
    if (!watch) throw new SupervisionError("监控不存在。", 404);
    return watch;
  }
  async discover(
    terminalSessionId: string,
    panelId?: string | null,
    _expectedThreadId?: string,
  ): Promise<SupervisionDiscovery> {
    void _expectedThreadId;
    await this.ready;
    await this.queue;
    const watch = this.forTerminal(terminalSessionId) ?? null;
    let target: SupervisionTarget;
    try {
      target = this.resolve(terminalSessionId, panelId).target;
    } catch (error) {
      return structuredClone({
        target: null,
        watch,
        capability: { supported: false, reason: (error as Error).message },
        taskCandidates: [],
      });
    }
    // History is context for processing a reply, never eligibility for enabling a terminal.
    const candidates = target.threadId
      ? await this.history
          .getConversation(target.threadId)
          .then(taskCandidates)
          .catch(() => [])
      : [];
    return structuredClone({
      target,
      watch,
      capability: { supported: true },
      taskCandidates: candidates,
    });
  }
  async get(id: string) {
    await this.ready;
    await this.queue;
    return structuredClone(this.find(id));
  }

  async start(request: StartSupervisionRequest): Promise<TaskWatch> {
    return this.transaction(async () => {
      const requestDigest = digest(JSON.stringify(request));
      const previous = this.journal.requests[request.requestId];
      if (previous) {
        if (previous.digest !== requestDigest)
          throw new SupervisionError("requestId 已用于不同请求。");
        return this.find(previous.watchId);
      }
      const { target } = this.resolve(request.target.terminalSessionId);
      let watch = this.forTerminal(target.terminalSessionId);
      if (!watch) {
        const now = new Date().toISOString();
        const pendingId = `pending:${randomUUID()}`;
        watch = {
          watchId: randomUUID(),
          enabled: true,
          enabledAt: now,
          target,
          taskStartMessageId: pendingId,
          task: { id: pendingId, role: "user", text: "", createdAt: now },
          goal: "当前终端任务",
          plans: [],
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
      } else {
        this.jobs.cancel(watch.watchId);
        watch.enabled = true;
        watch.enabledAt = new Date().toISOString();
        watch.status = "watching";
        delete watch.pauseReason;
        delete watch.error;
        watch.revision++;
        watch.updatedAt = new Date().toISOString();
      }
      this.journal.requests[request.requestId] = {
        digest: requestDigest,
        watchId: watch.watchId,
      };
      return watch;
    });
  }
  async change(id: string, request: ChangeSupervisionRequest) {
    return this.transaction(() => {
      const watch = this.find(id);
      if (watch.revision !== request.expectedRevision)
        throw new SupervisionError("监控状态已更新，请刷新。");
      this.jobs.cancel(id);
      if (request.action === "pause") {
        watch.enabled = false;
        watch.status = "paused";
        watch.pauseReason = "user_paused";
      } else if (request.action === "resume") {
        this.resolve(watch.target.terminalSessionId);
        watch.enabled = true;
        watch.enabledAt = new Date().toISOString();
        watch.status = "watching";
        delete watch.pauseReason;
      } else {
        if (!request.goal?.trim())
          throw new SupervisionError("目标不能为空。", 422);
        watch.goal = request.goal;
        watch.contextRevision++;
        if (watch.status === "classifying") watch.status = "watching";
      }
      watch.revision++;
      watch.updatedAt = new Date().toISOString();
      delete watch.error;
      return watch;
    });
  }
  /** Old installations may still invoke the separate Hook endpoint. It never classifies or delivers. */
  async hook(
    _request: SupervisionHookRequest,
  ): Promise<SupervisionHookResponse> {
    void _request;
    return ALLOW;
  }
  async validOffer(_id: string, _decisionId: string, _revision: number) {
    void _id;
    void _decisionId;
    void _revision;
    return false;
  }

  completed(event: TerminalEventEnvelope) {
    const reply = completionReply(event);
    if (reply) this.enqueueReply(reply);
  }
  /** The existing App Server consumer supplies all native hook and completion events. */
  observeEvent(event: AppServerEventEnvelope) {
    const observed = supervisionEvent(event);
    if (!observed) return;
    if (observed.kind === "reply") {
      this.enqueueReply(observed);
      return;
    }
    const watch = this.forTerminal(observed.terminalSessionId);
    if (
      !watch?.enabled ||
      Date.parse(observed.createdAt) < Date.parse(watch.enabledAt)
    )
      return;
    if (observed.threadId && observed.panelId) {
      try {
        if (
          this.resolve(observed.terminalSessionId, observed.panelId).target
            .threadId !== observed.threadId
        )
          return;
      } catch {
        return;
      }
    }
    if (
      ["sessionstart", "userpromptsubmit", "interrupt"].includes(observed.raw)
    )
      this.jobs.cancel(watch.watchId);
    void this.transaction(() => {
      const current = this.find(watch.watchId);
      if (current.enabled)
        updateWaitingState(current, observed.raw, observed.toolName);
    }).catch(() => undefined);
  }
  private enqueueReply(event: ReplyEvent) {
    if (this.closed) return;
    if (!this.forTerminal(event.terminalSessionId)?.enabled) return;
    const pending = (
      this.eventQueues.get(event.terminalSessionId) ?? Promise.resolve()
    )
      .catch(() => undefined)
      .then(() => this.consumeReply(event));
    this.eventQueues.set(event.terminalSessionId, pending);
    void pending
      .finally(() => {
        if (this.eventQueues.get(event.terminalSessionId) === pending)
          this.eventQueues.delete(event.terminalSessionId);
      })
      .catch(() => undefined);
  }
  private async consumeReply(event: ReplyEvent) {
    await this.ready;
    await this.queue;
    const watch = this.forTerminal(event.terminalSessionId);
    if (
      this.closed ||
      !watch?.enabled ||
      Date.parse(event.createdAt) < Date.parse(watch.enabledAt)
    )
      return;
    let target: SupervisionTarget;
    try {
      target = this.resolve(event.terminalSessionId, event.panelId).target;
    } catch {
      return;
    }
    // Thread is an event/delivery fence, not the owner of the terminal switch.
    if (
      !target.threadId ||
      (event.threadId && event.threadId !== target.threadId)
    )
      return;
    const session = this.manager.getSession(target.terminalSessionId)!;
    const inputRevision = terminalInputAdmission(session).revision;
    const controller = new AbortController();
    const promise = this.processReply(
      watch.watchId,
      target,
      event,
      controller,
      inputRevision,
    );
    const job = { controller, promise };
    this.jobs.add(watch.watchId, job);
    try {
      await promise;
    } finally {
      this.jobs.finish(watch.watchId, job);
    }
  }
  private async processReply(
    id: string,
    target: SupervisionTarget,
    event: ReplyEvent,
    controller: AbortController,
    inputRevision: object,
  ): Promise<SupervisionHookResponse> {
    let revision: number | undefined;
    try {
      let source = await this.history.getConversation(target.threadId);
      let messages = messagesFrom(source);
      const locate = () =>
        [...messages]
          .reverse()
          .find(
            (m) =>
              m.role === "assistant" &&
              m.phase !== "commentary" &&
              (!event.turnId || m.rawTurnId === event.turnId) &&
              (!event.summary ||
                m.text === event.summary ||
                m.text.startsWith(
                  event.summary.replace(/\n\.\.\.\[truncated\]$/, ""),
                )),
          );
      let native = locate();
      for (
        let attempt = 0;
        !native && attempt < 3 && !controller.signal.aborted;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        source = await this.history.getConversation(target.threadId);
        messages = messagesFrom(source);
        native = locate();
      }
      if (!native)
        throw new Error(
          "最终回复事件已收到，但完整会话尚不可读；等待下一条回复。",
        );
      const finalKey = `${target.threadId}:${native.id}`;
      const snapshot = await this.transaction(async () => {
        const w = this.find(id);
        if (!w.enabled || controller.signal.aborted || !this.current(target))
          return null;
        if (
          w.lastFinalMessageId === finalKey ||
          w.decisions.some(
            (d) =>
              d.input.currentReply.id === native!.id &&
              d.input.currentReply.rawTurnId ===
                (native!.rawTurnId ?? native!.id),
          )
        )
          return null;
        if (
          w.target.threadId !== target.threadId ||
          w.target.panelId !== target.panelId ||
          w.taskStartMessageId.startsWith("pending:")
        ) {
          const task = taskCandidates(source)[0];
          if (!task)
            throw new Error("监控已开启，但当前会话还没有可读的用户任务。");
          w.task = task;
          w.taskStartMessageId = task.id;
          w.goal = task.text;
          w.plans = [];
          w.continuationCount = 0;
          delete w.pauseReason;
          w.contextRevision++;
        }
        w.target = target;
        w.lastFinalMessageId = finalKey;
        reconcileDelivery(w, messages);
        if (w.pauseReason === "delivery_unknown")
          throw new Error("上次续接尚未确认接收，请检查原终端。");
        w.revision++;
        w.status = "classifying";
        delete w.error;
        delete w.waitingFor;
        w.updatedAt = new Date().toISOString();
        return w;
      });
      if (!snapshot) return ALLOW;
      revision = snapshot.revision;
      await refreshReferencedPlans(
        this.resolve(target.terminalSessionId, target.panelId).root,
        snapshot,
        messages,
      );
      const reply = {
        ...native,
        rawTurnId: native.rawTurnId ?? native.id,
        phase: "final" as const,
      };
      const input = buildSupervisionInput(snapshot, source, reply);
      const result = await this.classifier.run(input, {
        model: settingText("backend.taskSupervision.model"),
        timeoutMs: Number(
          setting("backend.taskSupervision.classificationTimeoutMs", 90_000),
        ),
        signal: controller.signal,
      });
      const offer = await this.transaction(() => {
        const w = this.find(id);
        if (
          !w.enabled ||
          w.revision !== revision ||
          controller.signal.aborted ||
          !this.current(target)
        )
          return ALLOW;
        w.plans = snapshot.plans;
        const decision = {
          ...result,
          decisionId: randomUUID(),
          threadId: target.threadId,
          rawTurnId: reply.rawTurnId,
          replyDigest: digest(reply.text),
          contextRevision: w.contextRevision,
          createdAt: new Date().toISOString(),
          input,
          delivery: "not_requested" as "not_requested" | "offered",
          deliveryDeadline: Date.now() + 30_000,
        };
        const session = this.manager.getSession(target.terminalSessionId)!;
        const paneId = this.manager.getPanel(target.panelId)?.tmuxPaneId ?? null;
        return applyVerdict(w, decision, !hasPendingTerminalInput(session, paneId));
      });
      if (offer.action !== "request-continuation") return ALLOW;
      const valid = () => {
        const w = this.find(id);
        if (
          this.closed ||
          !w.enabled ||
          w.revision !== offer.revision ||
          controller.signal.aborted ||
          !this.current(target) ||
          !this.manager.getSession(target.terminalSessionId)
        )
          throw new Error("原任务已变化，未发送旧续接。");
      };
      try {
        valid();
        if (
          terminalInputAdmission(
            this.manager.getSession(target.terminalSessionId)!,
          ).revision !== inputRevision
        )
          throw new Error("用户输入已变化，未发送旧续接。");
        if (!this.deliver) throw new Error("终端输入服务不可用。");
        await this.deliver(target, offer, valid);
      } catch (error) {
        await this.transaction(() => {
          const w = this.find(id);
          const decision = w.decisions.find(
            (d) => d.decisionId === offer.decisionId,
          )!;
          decision.delivery = "unknown";
          w.status = w.enabled ? "error" : "paused";
          w.revision++;
          w.error =
            error instanceof Error
              ? error.message
              : "续接投递失败，请检查原终端。";
        });
      }
      return ALLOW;
    } catch (error) {
      await this.transaction(() => {
        const w = this.find(id);
        if (
          !w.enabled ||
          controller.signal.aborted ||
          (revision !== undefined && w.revision !== revision)
        )
          return;
        w.status = "error";
        w.revision++;
        w.error = (
          error instanceof Error ? error.message : "回复处理失败"
        ).slice(0, 500);
        w.updatedAt = new Date().toISOString();
      }).catch(() => undefined);
      return ALLOW;
    }
  }
  private async reconcile() {
    await this.ready;
    for (const saved of this.journal.watches) {
      if (this.closed) return;
      await readPendingDeliveries(
        saved,
        (threadId) => this.history.getConversation(threadId),
        (messages, threadId) =>
          this.transaction(() => {
            reconcileDelivery(
              this.find(saved.watchId),
              messages,
              Date.now(),
              threadId,
            );
          }),
      );
    }
  }
  async dispose() {
    this.closed = true;
    this.unsubscribe?.();
    clearInterval(this.timer);
    this.jobs.cancelAll();
    await this.jobs.drain();
    await Promise.allSettled(this.eventQueues.values());
    await this.queue;
    await this.maintenance;
  }
}
