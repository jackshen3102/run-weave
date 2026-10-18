import { randomUUID } from "node:crypto";
import type {
  SideChat, SideChatCapabilities, SideChatMessagePage, SideChatOperation, SideChatSnapshot,
  SideChatSourceRef, SideChatTurn, SideChatWriteRequest, SendSideChatRequest, CreateSideChatResponse, SideChatWriteResponse,
} from "@runweave/shared/side-chat";
import { SIDE_CHAT_BUSY_STATES } from "@runweave/shared/side-chat";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { SideChatStore, type StoredChat, type StoredTurn } from "./store";
import { SideChatProvider } from "./provider";
import { finalMessages, type ProviderItem, type ProviderTurn } from "./final-messages";
import { assertSideChatSourceIdentity, resolveSideChatSource, sourceKey, sourceOwner, sideChatSourceStatus } from "./source";
import { SideChatError } from "./error";

type Execution = { provider: SideChatProvider; generation: string; turnId: string | null; items: Map<string, ProviderItem>; completed: ProviderTurn | null; retirement?: Promise<void> };
const now = () => new Date().toISOString();
const publicChat = ({ id, source, status, version, createdAt, endedAt }: StoredChat): SideChat => ({ id, source, status, version, createdAt, endedAt });
const publicTurn = ({ id, sideChatId, clientOperationId, state, acceptedAt, finishedAt, errorCode }: StoredTurn): SideChatTurn => ({ id, sideChatId, clientOperationId, state, acceptedAt, finishedAt, errorCode });

export class SideChatService {
  private executions = new Map<string, Execution>();
  private work = new Set<Promise<unknown>>();
  private closing = false;
  private disposal: Promise<void> | null = null;
  constructor(private readonly store: SideChatStore, private readonly manager: TerminalSessionManager, private readonly owner: string) {}

  /** Read only reconciliation. Never resumes a thread or replays an external write. */
  async recover(): Promise<void> {
    for (const chat of this.store.all()) {
      if (chat.ownerScope !== this.owner) continue;
      const turn = this.store.current(chat.id);
      if (chat.status === "creating") {
        this.store.transaction(() => { chat.status = "unavailable"; chat.version++; this.store.saveChat(chat); this.store.settleOperations(chat, null, "unknown"); });
        continue;
      }
      if (!chat.providerThreadId) continue;
      const reader = new SideChatProvider(chat.source.cwd);
      try {
        await reader.initialize();
        const { thread } = await reader.read(chat.providerThreadId);
        if (thread.id !== chat.providerThreadId) throw new Error("Child missing");
        const finished = turn?.providerTurnId ? thread.turns.find(item => item.id === turn.providerTurnId && ["completed", "interrupted", "failed"].includes(item.status)) : null;
        if (turn && SIDE_CHAT_BUSY_STATES.includes(turn.state)) {
          if (finished) this.complete(chat.id, turn.id, finished);
          else this.markUnknown(chat.id, turn.id);
        }
        if (chat.status === "ending" && thread.status.type !== "active") this.finishEnd(chat.id);
      } catch {
        if (turn && SIDE_CHAT_BUSY_STATES.includes(turn.state)) this.markUnknown(chat.id, turn.id);
        this.store.transaction(() => { const current = this.requireChat(chat.id); current.status = "unavailable"; current.version++; this.store.saveChat(current); });
      } finally { await reader.close(); }
    }
  }
  async capabilities(terminalId: string, panelId?: string): Promise<SideChatCapabilities> {
    try {
      const { panel } = sourceOwner(this.manager, terminalId, panelId);
      const existing = this.store.all().find(chat => chat.ownerScope === this.owner && chat.source.terminalSessionId === terminalId && chat.source.panelId === panel.id);
      if (existing) return { supported: true, reason: null, source: this.ref(existing.source), activeSideChatId: existing.id };
      const source = await resolveSideChatSource(this.manager, terminalId, panel.id);
      return { supported: true, reason: null, source: this.ref(source), activeSideChatId: null };
    } catch (error) {
      if (error instanceof SideChatError && error.status === 404) throw error;
      return { supported: false, reason: error instanceof SideChatError ? error.message : "Codex 协议或来源历史暂不可用", source: null, activeSideChatId: null };
    }
  }
  async create(operationId: string, ref: SideChatSourceRef): Promise<CreateSideChatResponse> {
    this.writable();
    const fingerprint = JSON.stringify(["create", ref]);
    const previous = this.repeated(operationId, fingerprint);
    if (previous) return { ...this.response(previous), sideChat: publicChat(this.requireChat(previous.sideChatId)) };
    const source = await resolveSideChatSource(this.manager, ref.terminalSessionId, ref.panelId, ref);
    this.writable();
    const result = this.store.transaction(() => {
      const repeated = this.repeated(operationId, fingerprint);
      if (repeated) return { chat: this.requireChat(repeated.sideChatId), operation: repeated, created: false };
      const active = this.store.active(this.owner, sourceKey(source));
      const chat: StoredChat = active ?? { id: randomUUID(), ownerScope: this.owner, sourceKey: sourceKey(source), source, providerThreadId: null, status: "creating", version: 1, createdAt: now(), endedAt: null };
      if (!active) this.store.saveChat(chat);
      const operation = this.accept(operationId, fingerprint, "create", chat, null, active ? "completed" : "accepted");
      return { chat, operation, created: !active };
    });
    if (result.created) {
      const task = this.createBranch(result.chat);
      await this.track(task);
    }
    const operation = this.operation(result.chat.id, operationId);
    return { ...this.response(operation), sideChat: publicChat(this.requireChat(result.chat.id)) };
  }
  snapshot(id: string): SideChatSnapshot {
    const chat = this.requireChat(id);
    const turn = this.store.current(id);
    return { sideChat: publicChat(chat), currentTurn: turn ? publicTurn(turn) : null, ...this.store.page(id), readAt: now(), sourceStatus: sideChatSourceStatus(this.manager, chat.source) };
  }
  messages(id: string, before?: number, limit?: number): SideChatMessagePage { this.requireChat(id); return this.store.page(id, before, limit); }
  operation(id: string, operationId: string): SideChatOperation {
    this.requireChat(id);
    const operation = this.store.operation(this.owner, operationId)?.result;
    if (!operation || operation.sideChatId !== id) throw new SideChatError(404, "OPERATION_NOT_FOUND", "未找到已接受操作，请保留草稿并刷新");
    return operation;
  }
  send(id: string, request: SendSideChatRequest): SideChatWriteResponse {
    this.writable();
    const fingerprint = JSON.stringify(["turn", id, request.expectedVersion, request.text]);
    const result = this.store.transaction(() => {
      const old = this.repeated(request.operationId, fingerprint); if (old) return { operation: old, turn: null };
      const chat = this.expected(id, request.expectedVersion);
      if (chat.status !== "active") throw new SideChatError(409, "CHAT_NOT_ACTIVE", "旁聊当前不能继续提问");
      const current = this.store.current(id);
      if (current && SIDE_CHAT_BUSY_STATES.includes(current.state)) throw new SideChatError(409, "TURN_IN_FLIGHT", "当前回答尚未结束或结果不明，请先核对状态");
      const turn: StoredTurn = { id: randomUUID(), sideChatId: id, clientOperationId: request.operationId, providerTurnId: null, state: "accepted", acceptedAt: now(), finishedAt: null, errorCode: null };
      chat.version++; this.store.saveChat(chat); this.store.saveTurn(turn);
      this.store.message({ id: `user:${turn.id}`, sideChatId: id, turnId: turn.id, role: "user", text: request.text, createdAt: turn.acceptedAt });
      return { operation: this.accept(request.operationId, fingerprint, "turn", chat, turn.id), turn };
    });
    if (result.turn) void this.track(this.run(id, result.turn.id, request.text));
    return this.response(result.operation);
  }
  stop(id: string, turnId: string, request: SideChatWriteRequest): SideChatWriteResponse {
    this.writable();
    const fingerprint = JSON.stringify(["stop", id, turnId, request.expectedVersion]);
    const operation = this.store.transaction(() => {
      const old = this.repeated(request.operationId, fingerprint); if (old) return old;
      const chat = this.expected(id, request.expectedVersion);
      const turn = this.store.current(id);
      if (!turn || turn.id !== turnId || !SIDE_CHAT_BUSY_STATES.includes(turn.state)) throw new SideChatError(409, "TURN_CHANGED", "当前回答已变化，请刷新");
      if (turn.state === "unknown") throw new SideChatError(409, "TURN_UNKNOWN", "无法确认执行结果，请保留记录并结束旁聊");
      turn.state = "stopping"; chat.version++; this.store.saveTurn(turn); this.store.saveChat(chat);
      return this.accept(request.operationId, fingerprint, "stop", chat, turnId);
    });
    void this.track(this.interrupt(id, turnId));
    return this.response(operation);
  }
  end(id: string, request: SideChatWriteRequest): SideChatWriteResponse {
    this.writable();
    const fingerprint = JSON.stringify(["end", id, request.expectedVersion]);
    const operation = this.store.transaction(() => {
      const old = this.repeated(request.operationId, fingerprint); if (old) return old;
      const chat = this.expected(id, request.expectedVersion);
      if (chat.status === "ended") throw new SideChatError(409, "CHAT_ENDED", "旁聊已结束");
      chat.status = "ending"; chat.version++; this.store.saveChat(chat);
      return this.accept(request.operationId, fingerprint, "end", chat, null);
    });
    void this.track(this.endBranch(id));
    return this.response(operation);
  }
  async deleted(terminalId: string): Promise<void> {
    const chats = this.store.all().filter(chat => chat.ownerScope === this.owner && chat.source.terminalSessionId === terminalId);
    for (const chat of chats) { chat.status = "ending"; chat.version++; this.store.saveChat(chat); await this.endBranch(chat.id); }
  }
  dispose(): Promise<void> {
    this.disposal ??= this.shutdown(); return this.disposal;
  }
  private async shutdown(): Promise<void> {
    this.closing = true;
    for (const chat of this.store.all()) {
      const turn = this.store.current(chat.id);
      if (turn && SIDE_CHAT_BUSY_STATES.includes(turn.state)) this.markUnknown(chat.id, turn.id);
    }
    const executions = [...this.executions.values()]; this.executions.clear();
    const results = await Promise.allSettled(executions.map(item => item.provider.close()));
    await Promise.allSettled([...this.work]);
    this.store.close();
    const errors = results.filter(result => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(result => (result as PromiseRejectedResult).reason), "Side chat executors failed to close");
  }
  private async createBranch(chat: StoredChat): Promise<void> {
    const execution = this.acquire(chat);
    try {
      await execution.provider.initialize();
      if (this.closing || this.requireChat(chat.id).status !== "creating") return;
      assertSideChatSourceIdentity(this.manager, chat.source);
      const fork = await execution.provider.fork(chat.source.expectedPrimaryThreadId, chat.source.lastCompletedTurnId, chat.source.model);
      this.store.transaction(() => {
        const current = this.requireChat(chat.id);
        current.providerThreadId = fork.thread.id;
        if (current.status === "creating") current.status = "active";
        current.version++; this.store.saveChat(current); this.store.settleOperations(current, null, "completed", "create");
      });
      if (this.requireChat(chat.id).status === "ending") await this.endBranch(chat.id);
    } catch {
      this.store.transaction(() => {
        const current = this.requireChat(chat.id);
        if (current.status === "creating") current.status = "unavailable";
        current.version++; this.store.saveChat(current); this.store.settleOperations(current, null, "unknown", "create");
      });
      this.executions.delete(chat.id); await execution.provider.close();
    }
  }
  private acquire(chat: StoredChat): Execution {
    const execution: Execution = { provider: new SideChatProvider(chat.source.cwd), generation: randomUUID(), turnId: null, items: new Map(), completed: null };
    this.executions.set(chat.id, execution);
    execution.provider.observe(event => {
      const current = this.executions.get(chat.id);
      if (current?.generation !== execution.generation || !execution.turnId) return;
      const bound = this.requireChat(chat.id);
      if (event.params?.threadId !== bound.providerThreadId) return;
      const turn = this.store.current(chat.id);
      if (!turn || turn.id !== execution.turnId || !SIDE_CHAT_BUSY_STATES.includes(turn.state)) return;
      const eventTurn = event.params.turnId ?? event.params.turn?.id;
      if (turn.providerTurnId && eventTurn !== turn.providerTurnId) return;
      if (event.method === "item/completed" && event.params.item?.type === "agentMessage") {
        const item = event.params.item;
        if ((item.text?.length ?? 0) > 1_048_576 || execution.items.size > 100) { this.markUnknown(chat.id, turn.id); return; }
        execution.items.set(item.id, { id: item.id, type: item.type, text: item.text, phase: item.phase });
      }
      if (event.method === "turn/completed" && event.params.turn) {
        execution.completed = event.params.turn;
        if (turn.providerTurnId) this.complete(chat.id, turn.id, { ...event.params.turn, items: [...execution.items.values()] });
      }
    }, () => {
      if (this.executions.get(chat.id)?.generation !== execution.generation) return;
      const turn = this.store.current(chat.id);
      if (turn && SIDE_CHAT_BUSY_STATES.includes(turn.state)) this.markUnknown(chat.id, turn.id);
      execution.retirement ??= this.track(execution.provider.close().then(() => {
        if (this.executions.get(chat.id)?.generation === execution.generation) this.executions.delete(chat.id);
      }));
    });
    return execution;
  }
  private async run(id: string, turnId: string, text: string): Promise<void> {
    let execution = this.executions.get(id);
    try {
      const chat = this.requireChat(id);
      if (execution?.retirement) { await execution.retirement; execution = this.executions.get(id); }
      if (!execution) {
        execution = this.acquire(chat); await execution.provider.initialize();
        if (!chat.providerThreadId) throw new Error("Unbound child");
        await execution.provider.resume(chat.providerThreadId, chat.source.model);
      }
      execution.turnId = turnId; execution.items.clear(); execution.completed = null;
      const current = this.requireChat(id); const turn = this.store.turn(turnId)!;
      if (this.closing || current.status !== "active" || turn.state === "stopping") {
        this.complete(id, turnId, { id: turn.providerTurnId ?? "", status: "interrupted" }); return;
      }
      const result = await execution.provider.start(current.providerThreadId!, turnId, text);
      this.store.transaction(() => {
        const latest = this.store.turn(turnId)!; latest.providerTurnId = result.turn.id;
        if (latest.state === "accepted") latest.state = "running";
        this.store.saveTurn(latest); const chat = this.requireChat(id); chat.version++; this.store.saveChat(chat);
      });
      const completed = this.executions.get(id)?.completed;
      if (completed?.id === result.turn.id) this.complete(id, turnId, { ...completed, items: [...execution.items.values()] });
      else if (this.store.turn(turnId)?.state === "stopping") await this.interrupt(id, turnId);
    } catch { this.markUnknown(id, turnId); }
  }
  private complete(id: string, turnId: string, result: ProviderTurn): void {
    this.store.transaction(() => {
      const chat = this.requireChat(id); const turn = this.store.current(id);
      if (!turn || turn.id !== turnId || !SIDE_CHAT_BUSY_STATES.includes(turn.state) || (turn.providerTurnId && turn.providerTurnId !== result.id)) return;
      const finals = finalMessages(result);
      turn.state = result.status === "interrupted" ? "stopped" : result.status === "failed" ? "failed" : finals.length ? "completed" : "failed";
      turn.finishedAt = now(); turn.errorCode = turn.state === "failed" ? "NO_FINAL_ANSWER" : null;
      this.store.saveTurn(turn);
      if (turn.state === "completed") for (const message of finals) this.store.message({ id: `${chat.id}:${message.id}`, sideChatId: id, turnId, role: "assistant", text: message.text, createdAt: turn.finishedAt });
      chat.version++; this.store.saveChat(chat); this.store.settleOperations(chat, turnId, "completed");
    });
  }
  private markUnknown(id: string, turnId: string): void {
    this.store.transaction(() => {
      const turn = this.store.current(id); if (!turn || turn.id !== turnId || !SIDE_CHAT_BUSY_STATES.includes(turn.state) || turn.state === "unknown") return;
      turn.state = "unknown"; turn.errorCode = "PROVIDER_OUTCOME_UNKNOWN"; this.store.saveTurn(turn);
      const chat = this.requireChat(id); chat.version++; this.store.saveChat(chat); this.store.settleOperations(chat, turnId, "unknown");
    });
  }
  private async interrupt(id: string, turnId: string): Promise<void> {
    const chat = this.requireChat(id); const turn = this.store.current(id); const execution = this.executions.get(id);
    if (!turn || turn.id !== turnId || !SIDE_CHAT_BUSY_STATES.includes(turn.state)) return;
    if (!turn.providerTurnId || !execution || !chat.providerThreadId) return;
    try { await execution.provider.interrupt(chat.providerThreadId, turn.providerTurnId); }
    catch { if (SIDE_CHAT_BUSY_STATES.includes(this.store.turn(turnId)!.state)) this.markUnknown(id, turnId); }
  }
  private async endBranch(id: string): Promise<void> {
    const turn = this.store.current(id);
    if (turn && SIDE_CHAT_BUSY_STATES.includes(turn.state)) await this.interrupt(id, turn.id);
    const execution = this.executions.get(id); this.executions.delete(id);
    if (execution) await execution.provider.close();
    this.finishEnd(id);
  }
  private finishEnd(id: string): void {
    this.store.transaction(() => {
      const chat = this.requireChat(id); if (chat.status === "ended") return;
      const turn = this.store.current(id);
      if (turn && SIDE_CHAT_BUSY_STATES.includes(turn.state)) {
        turn.state = "unknown"; turn.errorCode = "ENDED_WITHOUT_CONFIRMED_FINAL"; this.store.saveTurn(turn);
        this.store.settleOperations(chat, turn.id, "unknown");
      }
      chat.status = "ended"; chat.endedAt = now(); chat.version++; this.store.saveChat(chat);
      this.store.settleOperations(chat, null, "completed", "end");
    });
  }
  private requireChat(id: string): StoredChat {
    const chat = this.store.chat(id, this.owner);
    if (!chat) throw new SideChatError(404, "CHAT_NOT_FOUND", "旁聊不存在"); return chat;
  }
  private expected(id: string, version: number): StoredChat {
    const chat = this.requireChat(id);
    if (chat.version !== version) throw new SideChatError(409, "VERSION_CONFLICT", "旁聊已在另一端更新，请刷新后重试"); return chat;
  }
  private repeated(id: string, fingerprint: string): SideChatOperation | null {
    const old = this.store.operation(this.owner, id);
    if (old && old.fingerprint !== fingerprint) throw new SideChatError(409, "OPERATION_CONFLICT", "该操作 ID 已用于不同请求");
    return old?.result ?? null;
  }
  private accept(operationId: string, fingerprint: string, kind: SideChatOperation["kind"], chat: StoredChat, turnId: string | null, state: SideChatOperation["state"] = "accepted"): SideChatOperation {
    const result: SideChatOperation = { operationId, sideChatId: chat.id, kind, state, turnId, version: chat.version };
    this.store.saveOperation(this.owner, fingerprint, result); return result;
  }
  private ref({ terminalSessionId, panelId, expectedPrimaryThreadId, lastCompletedTurnId }: SideChatSourceRef): SideChatSourceRef { return { terminalSessionId, panelId, expectedPrimaryThreadId, lastCompletedTurnId }; }
  private response(operation: SideChatOperation): SideChatWriteResponse { return { operation, version: operation.version, turnId: operation.turnId }; }
  private writable(): void { if (this.closing) throw new SideChatError(503, "SHUTTING_DOWN", "服务正在关闭，请保留草稿"); }
  private track<T>(task: Promise<T>): Promise<T> {
    this.work.add(task); void task.finally(() => this.work.delete(task)).catch(() => undefined); return task;
  }
}
