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
import {
  sameTarget,
  synchronizeWatch,
  synchronizeContext,
} from "./synchronization";
import { readFinalReply, alreadyProcessedReply } from "./reply";
import {
  hasPendingTerminalInput,
  terminalInputAdmission,
} from "../terminal/runtime/input-admission";
import { resolveSupervisionTarget } from "./target";
import { SupervisionError } from "./errors";
export { SupervisionError } from "./errors";
import {
  buildSupervisionInput,
  digest,
  refreshReferencedPlans,
  taskCandidates,
} from "./context";
import { TaskSupervisionClassifier } from "./classifier";
import {
  reconcileDelivery,
  readPendingDeliveries,
} from "./delivery";
import { applyVerdict } from "./verdict";
import { retryContinuation, sendSupervisionOffer } from "./continuation";
import { SupervisionJobs } from "./jobs";
import { startWatch, changeWatch } from "./controls";
import {
  logInitialization,
  logWatchChanges,
  replyFields,
  supervisionLogger,
  watchFields,
} from "./diagnostics";
import {
  TaskSupervisionStore,
  findTerminalWatch,
  type SupervisionJournal,
} from "./store";

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
      logInitialization(saved.watches);
    });
    this.timer = setInterval(() => {
      if (!this.maintenance && !this.closed)
        this.maintenance = this.reconcile()
          .catch((error) =>
            supervisionLogger.error("task-supervision.maintenance.failed", { error }),
          )
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
      let result: T;
      try {
        result = await operation();
        await this.store.save(this.journal);
      } catch (error) {
        this.journal = before;
        throw error;
      }
      try {
        logWatchChanges(before.watches, this.journal.watches);
      } catch {
        // Diagnostics must not roll back or reject a successful state commit.
      }
      return structuredClone(result);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private resolve(terminalSessionId: string, panelId?: string | null) {
    return resolveSupervisionTarget(this.manager, terminalSessionId, panelId);
  }
  private current(target: SupervisionTarget) {
    try {
      return sameTarget(
        this.resolve(target.terminalSessionId, target.panelId).target,
        target,
      );
    } catch {
      return false;
    }
  }
  private forTerminal(id: string) {
    return findTerminalWatch(this.journal, id);
  }
  private find(id: string) {
    const watch = this.journal.watches.find((w) => w.watchId === id);
    if (!watch) throw new SupervisionError("监控不存在。", 404);
    return watch;
  }
  private synchronize(id: string, target: SupervisionTarget) {
    return synchronizeWatch(target, {
      watch: () => this.find(id),
      current: () => this.current(target),
      update: (change) => this.transaction(() => change(this.find(id))),
      cancel: () => this.jobs.cancel(id),
      read: (thread) => this.history.getConversation(thread),
    });
  }
  async discover(
    terminalSessionId: string,
    panelId?: string | null,
    _expectedThreadId?: string,
  ): Promise<SupervisionDiscovery> {
    void _expectedThreadId;
    await this.ready;
    await this.queue;
    let watch = this.forTerminal(terminalSessionId) ?? null;
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
    const candidates = watch
      ? await this.synchronize(watch.watchId, target)
      : target.threadId
        ? await this.history
            .getConversation(target.threadId)
            .then(taskCandidates)
            .catch(() => [])
        : [];
    watch = this.forTerminal(terminalSessionId) ?? null;
    return structuredClone({
      target,
      watch,
      inputVersion: terminalInputAdmission(this.manager.getSession(terminalSessionId)!).inputVersion,
      capability: { supported: true },
      taskCandidates: candidates,
    });
  }
  async get(id: string) {
    await this.ready;
    await this.queue;
    return structuredClone(this.find(id));
  }

  private watchControls() {
    return {
      find: (id: string) => this.find(id),
      resolve: (terminalSessionId: string) => this.resolve(terminalSessionId),
      cancel: (id: string) => this.jobs.cancel(id),
    };
  }
  async start(request: StartSupervisionRequest): Promise<TaskWatch> {
    return this.transaction(() => startWatch(this.journal, request, this.watchControls()));
  }
  async change(id: string, request: ChangeSupervisionRequest) {
    if (request.action === "retry-continuation") return retryContinuation(request, this.continuationOperations(id));
    return this.transaction(() => changeWatch(id, request, this.watchControls()));
  }

  private continuationOperations(id: string) {
    return {
      get: () => this.get(id), watch: () => this.find(id), manager: this.manager,
      read: (thread: string) => this.history.getConversation(thread),
      current: (target: SupervisionTarget) => this.current(target),
      transaction: <T>(operation: () => T | Promise<T>) => this.transaction(operation),
      cancel: () => this.jobs.cancel(id), closed: () => this.closed,
      deliver: this.deliver,
    };
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
  async observeEvent(event: AppServerEventEnvelope) {
    await this.ready;
    await this.queue;
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
    let target: SupervisionTarget;
    try {
      target = this.resolve(
        observed.terminalSessionId,
        observed.panelId,
      ).target;
      if (observed.threadId && target.threadId !== observed.threadId) return;
    } catch {
      return;
    }
    if (observed.raw === "interrupt") this.jobs.cancel(watch.watchId);
    if (
      ["sessionstart", "userpromptsubmit"].includes(observed.raw) ||
      !sameTarget(watch.target, target)
    )
      await this.synchronize(watch.watchId, target);
    // Native running observations also cover automatic supervision turns. Only a new
    // ordinary user message (above) advances the round; duplicate Hook/native events do not.
    if (["sessionstart", "userpromptsubmit"].includes(observed.raw)) return;
    await this.transaction(() => {
      const current = this.find(watch.watchId);
      if (
        current.enabled &&
        this.current(target) &&
        sameTarget(current.target, target)
      )
        updateWaitingState(current, observed.raw, observed.toolName);
    });
  }
  private enqueueReply(event: ReplyEvent) {
    if (this.closed) return;
    if (!this.forTerminal(event.terminalSessionId)?.enabled) return;
    supervisionLogger.info("task-supervision.reply.received", replyFields(event));
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
      .catch((error) => supervisionLogger.error("task-supervision.reply.queue.failed", {
        ...replyFields(event), error,
      }));
  }
  private async consumeReply(event: ReplyEvent) {
    await this.ready;
    await this.queue;
    const watch = this.forTerminal(event.terminalSessionId);
    if (
      this.closed ||
      !watch?.enabled ||
      Date.parse(event.createdAt) < Date.parse(watch.enabledAt)
    ) {
      supervisionLogger.info("task-supervision.reply.skipped", {
        ...replyFields(event),
        reason: this.closed ? "service_closed" : !watch?.enabled ? "disabled" : "before_enabled",
      });
      return;
    }
    let target: SupervisionTarget;
    try {
      target = this.resolve(event.terminalSessionId, event.panelId).target;
    } catch (error) {
      supervisionLogger.info("task-supervision.reply.skipped", {
        ...replyFields(event), reason: "target_unavailable", error,
      });
      return;
    }
    // Thread is an event/delivery fence, not the owner of the terminal switch.
    if (
      !target.threadId ||
      (event.threadId && event.threadId !== target.threadId)
    ) {
      supervisionLogger.info("task-supervision.reply.skipped", {
        ...replyFields(event), reason: "thread_mismatch", currentThreadId: target.threadId,
      });
      return;
    }
    await this.synchronize(watch.watchId, target);
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
    await this.jobs.runUntilCanceled(watch.watchId, { controller, promise });
  }
  private async processReply(
    id: string,
    target: SupervisionTarget,
    event: ReplyEvent,
    controller: AbortController,
    inputRevision: object,
  ): Promise<SupervisionHookResponse> {
    let revision: number | undefined;
    const startedAt = Date.now();
    let stage = "read_final_reply";
    const trace = {
      ...replyFields(event), ...target, watchId: id, attemptId: randomUUID(),
    };
    const skip = (reason: string) =>
      supervisionLogger.info("task-supervision.reply.skipped", { ...trace, reason });
    supervisionLogger.info("task-supervision.reply.started", trace);
    try {
      const { source, messages, native } = await readFinalReply(
        () => this.history.getConversation(target.threadId),
        event,
        controller.signal,
      );
      const finalKey = `${target.threadId}:${native.id}`;
      stage = "prepare_context";
      const snapshot = await this.transaction(async () => {
        const w = this.find(id);
        if (!w.enabled || controller.signal.aborted || !this.current(target)) {
          skip("target_changed_or_canceled");
          return null;
        }
        if (!sameTarget(w.target, target)) {
          skip("target_changed");
          return null;
        }
        synchronizeContext(w, taskCandidates(source));
        const latestUser = taskCandidates(source).at(-1);
        if (
          w.pauseReason === "interrupted" ||
          (latestUser &&
            messages.indexOf(latestUser) > messages.indexOf(native!))
        ) {
          skip("interrupted_or_new_user_input");
          return null;
        }
        if (alreadyProcessedReply(w, target.threadId, native)) {
          skip("duplicate_reply");
          return null;
        }
        if (w.taskStartMessageId.startsWith("pending:"))
          throw new Error("监控已开启，但当前会话还没有可读的用户任务。");
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
      stage = "build_input";
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
      stage = "classify";
      supervisionLogger.info("task-supervision.classification.started", {
        ...trace, ...watchFields(snapshot), replyMessageId: reply.id,
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
        configuredModel: settingText("backend.taskSupervision.model") ?? null,
        timeoutMs: Number(setting("backend.taskSupervision.classificationTimeoutMs", 90_000)),
      });
      const result = await this.classifier.run(input, {
        model: settingText("backend.taskSupervision.model"),
        timeoutMs: Number(
          setting("backend.taskSupervision.classificationTimeoutMs", 90_000),
        ),
        signal: controller.signal,
      });
      supervisionLogger.info("task-supervision.classification.finished", {
        ...trace, replyMessageId: reply.id, outcome: result.outcome,
        scores: result.scores, model: result.model, durationMs: result.durationMs,
      });
      stage = "commit_decision";
      const offer = await this.transaction(() => {
        const w = this.find(id);
        if (
          !w.enabled ||
          w.revision !== revision ||
          controller.signal.aborted ||
          !this.current(target)
        ) {
          skip("classification_superseded");
          return ALLOW;
        }
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
        const paneId =
          this.manager.getPanel(target.panelId)?.tmuxPaneId ?? null;
        return applyVerdict(
          w,
          decision,
          !hasPendingTerminalInput(session, paneId),
        );
      });
      if (offer.action !== "request-continuation") return ALLOW;
      stage = "deliver";
      await sendSupervisionOffer(target, offer, inputRevision, this.continuationOperations(id), {
        signal: controller.signal, trace,
      });
      return ALLOW;
    } catch (error) {
      if (controller.signal.aborted)
        supervisionLogger.info("task-supervision.reply.canceled", { ...trace, stage, durationMs: Date.now() - startedAt });
      else
        supervisionLogger.warn("task-supervision.reply.failed", { ...trace, stage, durationMs: Date.now() - startedAt, error });
      await this.transaction(() => {
        const w = this.find(id);
        if (
          !w.enabled ||
          controller.signal.aborted ||
          !this.current(target) ||
          (revision !== undefined && w.revision !== revision)
        )
          return;
        w.status = "error";
        w.revision++;
        w.error = (
          error instanceof Error ? error.message : "回复处理失败"
        ).slice(0, 500);
        w.updatedAt = new Date().toISOString();
      }).catch((saveError) => supervisionLogger.error("task-supervision.error_state.failed", {
        ...trace, error: saveError,
      }));
      return ALLOW;
    } finally {
      supervisionLogger.info("task-supervision.reply.finished", { ...trace, stage, durationMs: Date.now() - startedAt });
    }
  }
  private async reconcile() {
    await this.ready;
    for (const saved of this.journal.watches) {
      if (this.closed) return;
      try {
        await this.synchronize(
          saved.watchId,
          this.resolve(saved.target.terminalSessionId, saved.target.panelId)
            .target,
        );
      } catch {
        // An unavailable/exited Agent does not turn off the terminal switch.
      }
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
