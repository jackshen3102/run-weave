import { processSupervisionReply } from "./reply-processing";
import { discoverSupervision } from "./discovery";
import { SupervisionGoalEditor } from "./goal-editor";
import type { SupervisionConversationResponse } from "@runweave/shared/terminal/conversation";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configuration, setting, settingText } from "@runweave/config-node";
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
  PreviewSupervisionGoalRequest,
} from "@runweave/shared/task-supervision";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import { completionReply, supervisionEvent, type ReplyEvent } from "./events";
import { updateWaitingState } from "./waiting";
import {
  sameTarget,
  synchronizeTarget,
  synchronizeWatch,
} from "./synchronization";
import {
  terminalInputAdmission,
} from "../terminal/runtime/input-admission";
import { resolveSupervisionTarget } from "./target";
import { SupervisionError } from "./errors";
export { SupervisionError } from "./errors";
import {
  taskCandidates,
  readWatchContext,
  messagesFrom,
} from "./context";
import { TaskSupervisionClassifier } from "./classifier";
import {
  reconcileDelivery,
  recordArchivedDeliveryFailure,
  readPendingDeliveries,
} from "./delivery";
import { retryContinuation } from "./continuation";
import { SupervisionJobs } from "./jobs";
import { startWatch, changeWatch } from "./controls";
import {
  logInitialization,
  logWatchChanges,
  replyFields,
  supervisionLogger,
} from "./diagnostics";
import {
  TaskSupervisionStore,
  findTerminalWatch,
  type SupervisionJournal,
  type ArchiveChange,
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
  private additions: ArchiveChange[] = [];
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
  private readonly goalEditor: SupervisionGoalEditor;
  private unregisterConfiguration?: () => void;

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
    this.goalEditor = new SupervisionGoalEditor({
      get: (id) => this.get(id), find: (id) => this.find(id),
      read: (id, thread) => this.readContext(id, thread), current: (target) => this.current(target),
      root: (target) => this.resolve(target.terminalSessionId, target.panelId).root,
      inputRevision: (target) => terminalInputAdmission(this.manager.getSession(target.terminalSessionId)!).revision,
      generate: (watch, evidence, signal) => this.classifier.generateGoal(watch, evidence, { ...this.modelOptions(), signal }),
      transaction: (operation) => this.transaction(operation),
      archive: (id, goal) => { this.additions.push({ watchId: id, goal }); },
      archived: (id, revisionId) => this.store.goalDetail(id, revisionId),
      applied: (id, previewId) => this.store.goalApplied(id, previewId),
      recordApplication: (id, goalApplicationId) => { this.additions.push({ watchId: id, goalApplicationId }); },
      cancel: (id) => this.jobs.cancel(id), replay: (watch, source) => this.replayForGoal(watch, source),
    });
    this.ready = this.store.load().then((saved) => {
      this.journal = saved;
      if (!this.closed) this.unregisterConfiguration = configuration().register("backend.taskSupervision", () => {});
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
        this.additions = [];
        result = await operation();
        await this.store.save(this.journal, this.additions);
        this.additions = [];
      } catch (error) {
        this.additions = [];
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
  private async synchronize(id: string, target: SupervisionTarget) {
    if (!sameTarget(this.find(id).target, target))
      await this.transaction(() => {
        if (this.current(target)) synchronizeTarget(this.find(id), target, () => this.jobs.cancel(id));
      });
    return [];
  }
  private readContext(id: string, threadId: string) {
    return readWatchContext(this.find(id), threadId, (thread, ids) => this.history.getSupervisionContext(thread, ids));
  }
  async discover(terminalSessionId: string, panelId?: string | null, _expectedThreadId?: string): Promise<SupervisionDiscovery> {
    void _expectedThreadId;
    await this.ready; await this.queue;
    return discoverSupervision(this.manager, terminalSessionId, panelId,
      () => this.forTerminal(terminalSessionId) ?? null,
      (id, target) => this.synchronize(id, target));
  }
  async get(id: string) {
    await this.ready;
    await this.queue;
    return structuredClone(this.find(id));
  }

  async decisions(id: string, cursor?: string, limit = 20) {
    await this.get(id);
    return this.store.page(id, cursor, limit);
  }
  async decision(id: string, decisionId: string) {
    await this.get(id);
    const decision = this.store.detail(id, decisionId);
    if (!decision) throw new SupervisionError("判断记录不存在。", 404);
    return decision;
  }

  private modelOptions() {
    return { model: settingText("backend.taskSupervision.model"), timeoutMs: Number(setting("backend.taskSupervision.classificationTimeoutMs", 90_000)) };
  }
  previewGoal(id: string, request: PreviewSupervisionGoalRequest, signal?: AbortSignal) {
    return this.goalEditor.preview(id, request, signal);
  }
  applyGoal(id: string, previewId: string) { return this.goalEditor.apply(id, previewId); }
  async goals(id: string, cursor?: string) { await this.get(id); return this.store.goals(id, cursor); }
  async goalDetail(id: string, revisionId: string) {
    await this.get(id);
    const detail = this.store.goalDetail(id, revisionId);
    if (!detail) throw new SupervisionError("目标来源不存在。", 404);
    return detail;
  }
  private replayForGoal(watch: TaskWatch, source: SupervisionConversationResponse) {
    const messages = messagesFrom(source);
    const reply = messages.filter((m) => m.role === "assistant" && m.phase !== "commentary").at(-1);
    const user = taskCandidates(source).at(-1);
    if (!watch.enabled || watch.pauseReason === "interrupted" || !reply || !user || messages.indexOf(reply) < messages.indexOf(user)) return;
    this.enqueueReply({ kind: "reply", source: "terminal", eventId: `goal:${watch.goalDefinition!.revisionId}`, ...watch.target, summary: null, turnId: reply.rawTurnId, createdAt: new Date().toISOString() });
  }
  private watchControls() {
    return {
      find: (id: string) => this.find(id),
      resolve: (terminalSessionId: string) => this.resolve(terminalSessionId),
      cancel: (id: string) => { this.jobs.cancel(id); this.goalEditor.cancel(id); },
      receipt: (id: string) => this.store.receipt(id),
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
      read: (thread: string) => this.readContext(id, thread),
      current: (target: SupervisionTarget) => this.current(target),
      transaction: <T>(operation: () => T | Promise<T>) => this.transaction(operation),
      cancel: () => this.jobs.cancel(id), closed: () => this.closed,
      failure: (decisionId: string, error: unknown, current: boolean, started: boolean) => recordArchivedDeliveryFailure(this.find(id), this.store, this.additions, decisionId, error, current, started),
      deliver: this.deliver,
    };
  }
  /** Old installations may still invoke the separate Hook endpoint. It never classifies or delivers. */
  async hook(_request: SupervisionHookRequest): Promise<SupervisionHookResponse> {
    void _request;
    return ALLOW;
  }
  async validOffer(_id: string, _decisionId: string, _revision: number) {
    void [_id, _decisionId, _revision];
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
    if (observed.raw === "interrupt" || (observed.raw === "userpromptsubmit" && !observed.native)) this.jobs.cancel(watch.watchId);
    if (
      ["sessionstart", "userpromptsubmit"].includes(observed.raw) ||
      !sameTarget(watch.target, target)
    )
      await this.synchronize(watch.watchId, target);
    // Native running observations also cover automatic supervision turns. Only a new
    // ordinary user message (above) advances the round; duplicate Hook/native events do not.
    if (["sessionstart", "userpromptsubmit"].includes(observed.raw)) {
      if (!observed.native) await this.transaction(() => { delete this.find(watch.watchId).pendingReply; });
      const enabledAt = watch.enabledAt;
      // Input hooks can arrive before the native user message is flushed to disk.
      await delay(500);
      await synchronizeWatch(target, {
        watch: () => this.find(watch.watchId),
        current: () => !this.closed && this.find(watch.watchId).enabled
          && this.find(watch.watchId).enabledAt === enabledAt && this.current(target),
        update: (change) => this.transaction(() => change(this.find(watch.watchId))),
        cancel: () => this.jobs.cancel(watch.watchId), read: (thread) => this.readContext(watch.watchId, thread),
      });
      return;
    }
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
    await this.transaction(() => {
      if (this.current(target)) this.find(watch.watchId).pendingReply = { ...event, summary: null };
    });
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
  private processReply(id: string, target: SupervisionTarget, event: ReplyEvent, controller: AbortController, inputRevision: object) {
    return processSupervisionReply({
      readContext: (watchId, thread) => this.readContext(watchId, thread),
      transaction: (operation) => this.transaction(operation), find: (watchId) => this.find(watchId),
      current: (candidate) => this.current(candidate), resolve: (terminal, panel) => this.resolve(terminal, panel),
      manager: this.manager, classifier: this.classifier, store: this.store,
      modelOptions: () => this.modelOptions(), archive: (change) => { this.additions.push(change); },
      continuationOperations: (watchId) => this.continuationOperations(watchId),
    }, id, target, event, controller, inputRevision);
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
      if (saved.pendingReply && saved.enabled && !this.eventQueues.has(saved.target.terminalSessionId)) this.enqueueReply(saved.pendingReply);
      await readPendingDeliveries(
        saved,
        (threadId) => this.readContext(saved.watchId, threadId),
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
    this.unregisterConfiguration?.();
    this.unsubscribe?.();
    clearInterval(this.timer);
    this.jobs.cancelAll();
    await this.goalEditor.dispose();
    await this.jobs.drain();
    await Promise.allSettled(this.eventQueues.values());
    await this.queue;
    await this.maintenance;
    this.store.close();
  }
}
