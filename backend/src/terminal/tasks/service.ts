import { createHash } from "node:crypto";
import type { AppServerThreadDetailTurn } from "@runweave/shared/app-server-events";
import type {
  CreateTerminalTaskRequest, StartTerminalTaskRequest, SendTerminalTaskRequest,
  ControlTerminalTaskRequest, ReviewTerminalTaskRequest, InterruptTerminalTaskRequest,
  TerminalTask, TerminalTaskObservation,
} from "@runweave/shared/terminal/task";
import { AppServerHistoryGateway } from "../../work-history/app-server-history-gateway";
import type { TerminalSessionManager } from "../manager/manager";
import { createTerminalSession, type TerminalSessionCreationOptions } from "../application/create-session";
import { prepareTerminalAgent } from "../application/agent-preparation";
import { buildPaneTarget } from "../application/panel-common";
import { sendInputToSession } from "../application/input-dispatcher";
import { resolveConversationTarget } from "../application/conversation";
import { beginSupervisorDelivery, observeTerminalInput } from "../runtime/input-admission";
import { TerminalTaskStore } from "./store";

export class TerminalTaskError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function conflict(code: string, message: string): never { throw new TerminalTaskError(409, code, message); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class TerminalTaskService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly observers = new Map<string, () => void>();
  private closing = false;

  constructor(
    private readonly store: TerminalTaskStore,
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
    private readonly history = new AppServerHistoryGateway(),
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    for (const task of this.store.tasks.values()) this.watchInput(task);
  }

  list(): TerminalTask[] { return structuredClone([...this.store.tasks.values()]); }

  private get(id: string): TerminalTask {
    const task = this.store.tasks.get(id);
    if (!task) throw new TerminalTaskError(404, "task_not_found", "Terminal task not found");
    return task;
  }

  private touch(task: TerminalTask): Promise<void> {
    task.revision += 1;
    task.updatedAt = new Date().toISOString();
    return this.store.save();
  }

  private exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new TerminalTaskError(503, "service_closed", "Terminal task service is closing"));
    const work = (this.pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.pending.set(id, work);
    void work.finally(() => { if (this.pending.get(id) === work) this.pending.delete(id); }).catch(() => undefined);
    return work;
  }

  private watchInput(task: TerminalTask): void {
    const session = task.terminalSessionId ? this.manager.getSession(task.terminalSessionId) : null;
    if (!session || this.observers.has(task.taskId)) return;
    this.observers.set(task.taskId, observeTerminalInput(session, () => {
      if (task.control === "human") return;
      task.control = "human";
      task.controlReason = "terminal_input";
      // Ownership changes synchronously before the human key reaches the PTY.
      // A failed save disables all automatic writes; restart also defaults to human.
      try { void this.touch(task).catch(() => undefined); } catch { /* Human input remains available if storage failed. */ }
    }));
  }

  private checkRevision(task: TerminalTask, revision: number): void {
    this.store.assertWritable();
    if (task.revision !== revision) conflict("revision_conflict", "Task changed; observe again before writing");
  }

  private target(task: TerminalTask) {
    const session = task.terminalSessionId ? this.manager.getSession(task.terminalSessionId) : null;
    const panel = task.panelId ? this.manager.getPanel(task.panelId) : null;
    if (!session || session.status !== "running" || session.runtimeKind !== "tmux" ||
        !panel || panel.terminalSessionId !== session.id || panel.status !== "running" || !this.options.tmuxService)
      conflict("terminal_unavailable", "Original terminal or panel is unavailable; no replacement was created");
    return { session, panel, pane: buildPaneTarget(session, this.options.tmuxService, panel) };
  }

  private assertIdentity(task: TerminalTask): void {
    const { session, panel } = this.target(task);
    const identity = resolveConversationTarget(this.manager, session.id, panel.id).target;
    if (task.threadId && (identity?.threadId !== task.threadId || identity.provider !== "codex"))
      conflict("target_changed", "Original Codex thread changed; automatic input disabled");
    if (task.launchOperationId && !this.manager.matchesPanelAgentOperationGeneration(session.id, panel.id, task.launchOperationId, "codex"))
      conflict("target_changed", "Agent launch generation changed");
  }

  private assertControl(task: TerminalTask): void {
    if (task.control !== "supervisor") conflict("human_control", "User has control; observe and explicitly return control before sending");
    this.assertIdentity(task);
  }

  private bootstrap(task: TerminalTask): string { return `RW_TASK_READY_${digest(task.taskId).slice(0, 20)}`; }

  create(request: CreateTerminalTaskRequest): Promise<TerminalTask> {
    return this.exclusive(request.taskId, async () => {
      this.store.assertWritable();
      const existing = this.store.tasks.get(request.taskId);
      if (existing) {
        if (existing.projectId !== request.projectId || existing.cwd !== request.cwd || existing.goal !== request.goal)
          conflict("task_conflict", "Task key already exists with different creation arguments");
        return structuredClone(existing);
      }
      const now = new Date().toISOString();
      const task: TerminalTask = { ...request, terminalSessionId: null, panelId: null,
        provider: "codex", threadId: null, launchOperationId: null, phase: "creating",
        control: "supervisor", controlReason: "created", revision: 0, createdAt: now,
        updatedAt: now, dispatches: [], reviews: [] };
      this.store.tasks.set(task.taskId, task);
      await this.touch(task);
      try {
        const session = await createTerminalSession(this.manager, { projectId: task.projectId, cwd: task.cwd, runtimePreference: "tmux" }, {
          ...this.options, strictDefaultPanel: true,
          onSessionCreated: async (id) => { task.terminalSessionId = id; await this.touch(task); },
        });
        task.panelId = this.manager.getPanelWorkspace(session.id)?.activePanelId ?? null;
        this.target(task);
        task.phase = "created";
        this.watchInput(task);
      } catch (error) {
        task.phase = "unavailable";
        task.error = String(error);
      }
      await this.touch(task);
      return structuredClone(task);
    });
  }

  start(id: string, request: StartTerminalTaskRequest): Promise<TerminalTask> {
    return this.exclusive(id, async () => {
      const task = this.get(id);
      // Never replay an uncertain launch, including after a lost HTTP response.
      if (task.phase !== "created") return structuredClone(task);
      this.checkRevision(task, request.expectedRevision);
      this.assertControl(task);
      const { session, panel } = this.target(task);
      if (panel.terminalState?.state !== "shell_idle") conflict("agent_not_idle", "Task terminal is no longer an idle shell");
      const release = beginSupervisorDelivery(session);
      try {
        task.phase = "starting";
        await this.touch(task);
        const prepared = await prepareTerminalAgent(this.manager, session, this.options, {
          agent: "codex", panelId: panel.id, cwd: task.cwd,
          prompt: `初始化任务终端。只回复 ${this.bootstrap(task)}，不要执行其他工作。`,
          ...(request.commandLine ? { commandLine: request.commandLine } : {}),
        }, { supervisorInput: true, validateSupervisorTarget: () => this.assertControl(task) });
        task.launchOperationId = prepared.operationId;
        await this.touch(task);
      } catch (error) {
        task.error = String(error);
        await this.touch(task);
      } finally { await release(); }
      return structuredClone(task);
    });
  }

  observe(id: string, afterTurnId?: string): Promise<TerminalTaskObservation> {
    return this.exclusive(id, () => this.observeNow(this.get(id), afterTurnId));
  }

  private async observeNow(task: TerminalTask, afterTurnId?: string): Promise<TerminalTaskObservation> {
    let turns: AppServerThreadDetailTurn[] = [];
    let availability: TerminalTaskObservation["availability"] = "starting";
    let error: string | undefined;
    let changed = false;
    let partial = false;
    let terminalState = null;
    try {
      const { session, panel } = this.target(task);
      terminalState = panel.terminalState ?? null;
      this.assertIdentity(task);
      const identity = resolveConversationTarget(this.manager, session.id, panel.id).target;
      if (identity?.provider === "codex" && task.launchOperationId) {
        const response = await this.history.getThreadDetail(identity.threadId);
        this.assertIdentity(task);
        const current = resolveConversationTarget(this.manager, session.id, panel.id).target;
        if (current?.threadId !== identity.threadId) conflict("target_changed", "Thread changed while reading");
        if (response.availability !== "available" || !response.detail || !("threadId" in response.detail) ||
            response.detail.provider !== "codex" || response.detail.threadId !== identity.threadId)
          throw new Error("Native Codex turn history unavailable");
        turns = response.detail.turns;
        partial = turns.some((turn) => turn.itemsView !== "full");
        const bootstrap = turns.find((turn) => turn.messages.some((message) => message.role === "user" && message.text.includes(this.bootstrap(task))));
        if (task.phase === "starting" && bootstrap?.status === "completed" && panel.terminalState?.state === "agent_idle") {
          task.threadId = identity.threadId;
          task.phase = "ready";
          delete task.error;
          changed = true;
        }
        availability = task.phase === "ready" ? "available" : "starting";
        for (const dispatch of task.dispatches) {
          const matches = turns.filter((turn) => turn.messages.some((message) => message.role === "user" && message.text.trim() === dispatch.wireText.trim()));
          if (matches.length !== 1) continue;
          const turn = matches[0]!;
          if (dispatch.turnId && dispatch.turnId !== turn.id) continue;
          if (dispatch.status !== "received" || dispatch.turnStatus !== turn.status) {
            dispatch.status = "received";
            dispatch.turnId = turn.id;
            dispatch.turnStatus = turn.status;
            changed = true;
          }
        }
      }
    } catch (caught) {
      error = String(caught);
      availability = caught instanceof TerminalTaskError && caught.code === "target_changed" ? "target_changed"
        : caught instanceof TerminalTaskError && caught.code === "terminal_unavailable" ? "terminal_unavailable" : "source_unavailable";
    }
    if (changed) await this.touch(task);
    if (afterTurnId && availability === "available") {
      const index = turns.findIndex((turn) => turn.id === afterTurnId);
      if (index < 0) conflict("cursor_missing", "Turn cursor not found; request a full observation");
      // Include the cursor turn: it may have gained messages or reached a terminal state.
      turns = turns.slice(index);
    }
    const snapshot = structuredClone(task);
    return { task: snapshot, terminalUrl: task.terminalSessionId ? `/terminal/${task.terminalSessionId}` : null,
      terminalState, availability, turns, partial, error, readAt: new Date().toISOString(),
      cursor: digest({ task: snapshot, terminalState, availability, turns, partial, error }) };
  }

  send(id: string, request: SendTerminalTaskRequest): Promise<TerminalTaskObservation> {
    return this.exclusive(id, async () => {
      const task = this.get(id);
      const old = task.dispatches.find((item) => item.dispatchId === request.dispatchId);
      if (old) {
        if (old.text !== request.text || old.delivery !== request.delivery) conflict("dispatch_conflict", "Dispatch key already exists with different content or delivery mode");
        return this.observeNow(task);
      }
      this.checkRevision(task, request.expectedRevision);
      this.assertControl(task);
      const observation = await this.observeNow(task);
      this.assertControl(task);
      if (observation.availability !== "available" || task.phase !== "ready") conflict("agent_not_ready", "Agent bootstrap and native history must be ready before business input");
      if (task.dispatches.some((item) => item.status !== "received")) conflict("delivery_unresolved", "Reconcile the previous dispatch before sending another");
      const { session, panel, pane } = this.target(task);
      const state = panel.terminalState?.state;
      if (state !== "agent_idle" && !(request.delivery === "queue" && state === "agent_running"))
        conflict("agent_busy", "Agent is busy; explicitly request queue delivery or wait for idle");
      const release = beginSupervisorDelivery(session);
      try {
        this.assertControl(task);
        const dispatch = { dispatchId: request.dispatchId, text: request.text, delivery: request.delivery,
          wireText: `任务投递标识：rw:${digest([id, request.dispatchId]).slice(0, 24)}\n\n${request.text}`,
          status: "delivery_unknown" as const, sentAt: new Date().toISOString(), turnId: null, turnStatus: null };
        task.dispatches.push(dispatch);
        // Persist intent before PTY I/O. A crash here is unknown, never automatically replayed.
        await this.touch(task);
        this.assertControl(task);
        try {
          await sendInputToSession(this.manager, { ...this.options, supervisorInput: true, validateSupervisorTarget: () => {
            this.assertControl(task);
            if (request.delivery === "when_idle" && this.target(task).panel.terminalState?.state !== "agent_idle")
              conflict("agent_busy", "Agent changed before input; no business text written");
          } }, session,
            dispatch.wireText, "prompt_paste", request.dispatchId, pane);
          Object.assign(dispatch, { status: "written" });
        } catch (caught) { Object.assign(dispatch, { error: String(caught) }); }
        await this.touch(task);
      } finally { await release(); }
      return this.observeNow(task);
    });
  }

  control(id: string, request: ControlTerminalTaskRequest): Promise<TerminalTaskObservation> {
    return this.exclusive(id, async () => {
      const task = this.get(id);
      this.checkRevision(task, request.expectedRevision);
      if (request.control === "supervisor") {
        this.assertIdentity(task);
        if (task.control === "human" && request.draftCleared !== true)
          conflict("draft_confirmation_required", "Finish or clear the TUI draft, then explicitly confirm draftCleared");
      }
      task.control = request.control;
      task.controlReason = "explicit_handoff";
      await this.touch(task);
      return this.observeNow(task);
    });
  }

  review(id: string, request: ReviewTerminalTaskRequest): Promise<TerminalTaskObservation> {
    return this.exclusive(id, async () => {
      const task = this.get(id);
      const { expectedRevision, ...review } = request;
      const old = task.reviews.find((item) => item.reviewId === review.reviewId);
      if (old) {
        if (old.dispatchId !== review.dispatchId || old.outcome !== review.outcome || old.summary !== review.summary ||
          JSON.stringify(old.evidence) !== JSON.stringify(review.evidence)) conflict("review_conflict", "Review key already exists with different content");
        return this.observeNow(task);
      }
      this.checkRevision(task, expectedRevision);
      const observation = await this.observeNow(task);
      const dispatch = task.dispatches.find((item) => item.dispatchId === review.dispatchId);
      // A reader that does not own the live TUI can temporarily report its turn
      // as interrupted. Require the execution-side idle signal as well.
      if (observation.availability !== "available" || observation.terminalState?.state !== "agent_idle" ||
        !dispatch?.turnId || !dispatch.turnStatus || dispatch.turnStatus === "inProgress")
        conflict("result_not_settled", "An idle Agent and matching native terminal turn are required before review");
      if (review.outcome === "accepted" && (dispatch.turnStatus !== "completed" || review.evidence.length === 0))
        conflict("evidence_required", "Acceptance requires a completed turn and independently checked evidence references");
      task.reviews.push({ ...review, createdAt: new Date().toISOString() });
      await this.touch(task);
      return this.observeNow(task);
    });
  }

  interrupt(id: string, request: InterruptTerminalTaskRequest): Promise<TerminalTaskObservation> {
    return this.exclusive(id, async () => {
      const task = this.get(id);
      this.checkRevision(task, request.expectedRevision);
      this.assertControl(task);
      const observation = await this.observeNow(task);
      if (observation.availability !== "available" || request.scope !== "terminal")
        conflict("terminal_unavailable", "Explicit terminal scope and available original thread are required");
      const { session, panel, pane } = this.target(task);
      if (panel.terminalState?.state !== "agent_running") conflict("turn_not_running", "Original Agent is no longer running");
      const release = beginSupervisorDelivery(session);
      try {
        this.assertControl(task);
        task.interruptRequestedAt = new Date().toISOString();
        await this.touch(task);
        await sendInputToSession(this.manager, { ...this.options, supervisorInput: true, validateSupervisorTarget: () => this.assertControl(task) }, session, "\u001b", "raw", undefined, pane);
      } finally { await release(); }
      // Escape accepted is never presented as cancellation confirmed.
      return this.observeNow(task);
    });
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending.values());
    for (const unwatch of this.observers.values()) unwatch();
    this.observers.clear();
    await this.store.close();
  }
}
