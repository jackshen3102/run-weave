import { create } from "zustand";
import { SIDE_CHAT_BUSY_STATES, SIDE_CHAT_TEXT_MAX_BYTES, type SideChatCapabilities, type SideChatMessage, type SideChatOperation, type SideChatSnapshot } from "@runweave/shared/side-chat";
import { SideChatApi } from "../../services/side-chat";
import { HttpError } from "../../services/http";

interface Navigation { chatId: string | null; visible: boolean }
interface Draft { text: string; start: number; end: number; revision: number }
interface Pending { operationId: string; chatId: string | null; kind: SideChatOperation["kind"]; draft: Draft | null }
interface State { capabilities: SideChatCapabilities | null; snapshot: SideChatSnapshot | null; draft: Draft; pending: Pending | null; loading: boolean; stale: boolean; error: string | null; unread: boolean; composing: boolean }
const EMPTY_DRAFT: Draft = { text: "", start: 0, end: 0, revision: 0 };
function read<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; } catch { return fallback; } }
function save(key: string, value: unknown): void { localStorage.setItem(key, JSON.stringify(value)); }
const clientId = (() => { const key = "runweave.side-chat.client.v1"; const id = read<string | null>(key, null) ?? crypto.randomUUID(); try { save(key, id); } catch { /* In-memory editing still works. */ } return id; })();
const navKey = "runweave.side-chat.navigation.v1";
export const sideChatKey = (scope: string, terminalId: string) => JSON.stringify([scope, terminalId, clientId]);
export const useSideChatNavigation = create<{ entries: Record<string, Navigation>; set: (key: string, next: Navigation) => void }>((set, get) => ({
  entries: read<Record<string, Navigation>>(navKey, {}),
  set: (key, next) => { const entries = { ...get().entries, [key]: next }; set({ entries }); try { save(navKey, entries); } catch { /* Server records remain available. */ } },
}));

/** One data owner per terminal/client. Header, Tab, and message view share it. */
export class SideChatModel {
  state: State;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private nextView: boolean | null = null;
  constructor(readonly key: string, private api: SideChatApi, readonly terminalId: string, private panelId: string | null) {
    const chatId = this.navigation.chatId;
    this.state = { capabilities: null, snapshot: chatId ? read(this.archiveKey(chatId), null) : null,
      draft: chatId ? read(this.draftKey(chatId), EMPTY_DRAFT) : EMPTY_DRAFT, pending: read(this.pendingKey, null), loading: false, stale: true, error: null, unread: false, composing: false };
  }
  get navigation(): Navigation { return useSideChatNavigation.getState().entries[this.key] ?? { chatId: null, visible: false }; }
  updateApi(api: SideChatApi, panelId: string | null): void { this.api = api; this.panelId = panelId; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  private patch(next: Partial<State>): void { this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener(); }
  private get pendingKey() { return `runweave.side-chat.pending.v1:${this.key}`; }
  private draftKey(id: string) { return `runweave.side-chat.draft.v1:${JSON.stringify([this.key, id])}`; }
  private archiveKey(id: string) { return `runweave.side-chat.snapshot.v1:${JSON.stringify([this.key, id])}`; }
  private readKey(id: string) { return `runweave.side-chat.read.v1:${JSON.stringify([this.key, id])}`; }
  setDraft(text: string, start: number, end: number): void {
    const previous = this.state.draft;
    const draft = { text, start, end, revision: previous.revision + (text === previous.text ? 0 : 1) };
    this.patch({ draft }); const id = this.navigation.chatId;
    if (id) try { save(this.draftKey(id), draft); } catch { this.patch({ error: "本地草稿保存失败，请先复制文字" }); }
  }
  composition(active: boolean): void {
    this.patch({ composing: active });
    if (!active && this.nextView !== null) { const visible = this.nextView; this.nextView = null; this.view(visible); }
  }
  view(visible: boolean): void {
    if (this.state.composing) { this.nextView = visible; (document.activeElement as HTMLElement | null)?.blur(); return; }
    useSideChatNavigation.getState().set(this.key, { ...this.navigation, visible });
    if (visible) void this.refresh();
  }
  async discover(): Promise<void> {
    try { this.patch({ capabilities: await this.api.capabilities(this.terminalId, this.panelId) }); }
    catch (error) { if (error instanceof HttpError && error.status === 404) this.patch({ capabilities: null }); else this.patch({ error: String(error) }); }
  }
  async open(): Promise<void> {
    if (this.state.loading) return;
    if (this.navigation.chatId && this.state.snapshot?.sideChat.status !== "ended") { this.view(true); return; }
    this.patch({ loading: true, error: null });
    let submittedId: string | undefined;
    try {
      const caps = await this.api.capabilities(this.terminalId, this.panelId); this.patch({ capabilities: caps });
      if (!caps.supported || !caps.source) { this.patch({ error: caps.reason ?? "此终端暂不支持消息旁聊" }); return; }
      if (caps.activeSideChatId) this.attach(caps.activeSideChatId);
      else {
        if (this.state.pending) { this.patch({ error: "上次创建结果待核对，请先查询操作" }); return; }
        const pending: Pending = { operationId: crypto.randomUUID(), chatId: null, kind: "create", draft: null }; submittedId = pending.operationId; this.pending(pending);
        const result = await this.api.create({ operationId: pending.operationId, source: caps.source });
        this.attach(result.sideChat.id);
        this.pending(result.operation.state === "unknown" ? { ...pending, chatId: result.sideChat.id } : null);
      }
      this.view(true); await this.refresh();
    } catch (error) { this.failure(error, submittedId); }
    finally { this.patch({ loading: false }); }
  }
  private attach(chatId: string): void {
    useSideChatNavigation.getState().set(this.key, { chatId, visible: this.navigation.visible });
    this.patch({ snapshot: read(this.archiveKey(chatId), null), draft: read(this.draftKey(chatId), EMPTY_DRAFT) });
  }
  start(): () => void {
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      if (document.visibilityState === "visible" && navigator.onLine) await this.refresh();
      else this.patch({ stale: true });
      if (this.polling) this.timer = setTimeout(tick, this.navigation.visible ? this.busy ? 1000 : 3000 : 5000);
    };
    const wake = () => { if (document.visibilityState === "visible") void this.refresh(); };
    document.addEventListener("visibilitychange", wake); window.addEventListener("online", wake);
    void this.discover(); void tick();
    return () => { this.polling = false; if (this.timer) clearTimeout(this.timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }
  get busy(): boolean { return Boolean(this.state.snapshot?.currentTurn && SIDE_CHAT_BUSY_STATES.includes(this.state.snapshot.currentTurn.state)); }
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => { this.inFlight = null; }); return this.inFlight;
  }
  private async load(): Promise<void> {
    const id = this.navigation.chatId; if (!id || document.visibilityState !== "visible") return;
    try {
      const snapshot = await this.api.snapshot(id);
      if (id !== this.navigation.chatId || snapshot.sideChat.version < (this.state.snapshot?.sideChat.version ?? 0)) return;
      const previous = this.state.snapshot?.messages ?? [];
      const merged = new Map(previous.map(message => [message.id, message]));
      for (const message of snapshot.messages) merged.set(message.id, message);
      let cursor = snapshot.beforeSequence;
      const previousLast = previous.at(-1)?.sequence;
      // Catch up through every missing page before merging; never replace a complete list with 50 rows.
      if (previousLast !== undefined) while (cursor && cursor > previousLast + 1) {
        const page = await this.api.messages(id, cursor);
        for (const message of page.messages) merged.set(message.id, message);
        cursor = page.beforeSequence;
      }
      if (id !== this.navigation.chatId || snapshot.sideChat.version < (this.state.snapshot?.sideChat.version ?? 0)) return;
      const messages = [...merged.values()].sort((a, b) => a.sequence - b.sequence);
      const value = { ...snapshot, messages, beforeSequence: previous.length && previous[0]!.sequence < (snapshot.messages[0]?.sequence ?? Infinity) ? this.state.snapshot!.beforeSequence : cursor };
      const lastAnswer = messages.filter(message => message.role === "assistant").at(-1)?.sequence ?? 0;
      this.patch({ snapshot: value, stale: false, unread: lastAnswer > read<number>(this.readKey(id), 0) });
      try { save(this.archiveKey(id), value); } catch { this.patch({ error: "本地消息缓存已满，服务器记录仍可读取" }); }
      if (this.state.pending) await this.reconcilePending();
    } catch (error) { this.patch({ stale: true, error: error instanceof Error ? error.message : "连接中断，请刷新" }); }
  }
  async older(): Promise<void> {
    const snapshot = this.state.snapshot; if (!snapshot?.beforeSequence) return;
    try {
      const page = await this.api.messages(snapshot.sideChat.id, snapshot.beforeSequence);
      if (this.state.snapshot?.sideChat.id !== snapshot.sideChat.id) return;
      const merged = new Map([...page.messages, ...this.state.snapshot.messages].map(message => [message.id, message]));
      this.patch({ snapshot: { ...this.state.snapshot, messages: [...merged.values()].sort((a, b) => a.sequence - b.sequence), beforeSequence: page.beforeSequence } });
    } catch (error) { this.failure(error); }
  }
  presented(): void {
    const id = this.navigation.chatId; if (!id || !this.navigation.visible || this.state.stale) return;
    const sequence = this.state.snapshot?.messages.filter(message => message.role === "assistant").at(-1)?.sequence ?? 0;
    try { save(this.readKey(id), sequence); } catch { return; } this.patch({ unread: false });
  }
  async send(): Promise<void> {
    const snapshot = this.state.snapshot; const draft = { ...this.state.draft };
    if (!snapshot || this.state.pending || this.busy || this.state.composing || this.state.stale || snapshot.sideChat.status !== "active") return;
    if (!draft.text.trim() || new TextEncoder().encode(draft.text).byteLength > SIDE_CHAT_TEXT_MAX_BYTES) { this.patch({ error: "请输入非空文字，最多 64 KiB" }); return; }
    const pending: Pending = { operationId: crypto.randomUUID(), chatId: snapshot.sideChat.id, kind: "turn", draft }; this.pending(pending);
    try { const result = await this.api.send(snapshot.sideChat.id, { operationId: pending.operationId, expectedVersion: snapshot.sideChat.version, text: draft.text }); this.accepted(result.operation, pending); await this.refresh(); }
    catch (error) { this.failure(error, pending.operationId); }
  }
  get canEnd(): boolean {
    const snapshot = this.state.snapshot;
    return Boolean(snapshot && !this.state.stale && !["ended", "ending"].includes(snapshot.sideChat.status) &&
      (!this.state.pending || snapshot.sideChat.status === "unavailable" || snapshot.currentTurn?.state === "unknown"));
  }
  async stop(): Promise<void> { await this.write("stop"); }
  async end(): Promise<void> { await this.write("end"); }
  private async write(kind: "stop" | "end"): Promise<void> {
    const snapshot = this.state.snapshot;
    if (!snapshot || this.state.stale || (this.state.pending && !(kind === "end" && this.canEnd))) return;
    const pending: Pending = { operationId: crypto.randomUUID(), chatId: snapshot.sideChat.id, kind, draft: { ...this.state.draft } }; this.pending(pending);
    const body = { operationId: pending.operationId, expectedVersion: snapshot.sideChat.version };
    try {
      const result = kind === "end" ? await this.api.end(snapshot.sideChat.id, body) : await this.api.stop(snapshot.sideChat.id, snapshot.currentTurn!.id, body);
      this.accepted(result.operation, pending); await this.refresh();
    } catch (error) { this.failure(error, pending.operationId); }
  }
  async reconcilePending(): Promise<void> {
    const pending = this.state.pending; if (!pending) return;
    try {
      let id = pending.chatId;
      if (!id) { const caps = await this.api.capabilities(this.terminalId, this.panelId); id = caps.activeSideChatId; if (id) this.attach(id); }
      if (!id) { this.patch({ error: "创建结果尚未确认，请保留草稿并稍后查询" }); return; }
      const operation = await this.api.operation(id, pending.operationId);
      this.accepted(operation, { ...pending, chatId: id });
    } catch { this.patch({ error: "操作结果仍未确认，请保留草稿；不会自动重发" }); }
  }
  private accepted(operation: SideChatOperation, pending: Pending): void {
    if (this.state.pending?.operationId !== pending.operationId) return;
    const retained = pending.draft?.revision !== this.state.draft.revision;
    if (operation.state === "unknown") { this.patch({ error: "执行结果不明，请保留草稿并查询状态" }); return; }
    if (pending.kind === "end" && operation.state !== "completed") return;
    if ((pending.kind === "turn" || pending.kind === "end") && pending.chatId === this.navigation.chatId && pending.draft?.revision === this.state.draft.revision) this.setDraft("", 0, 0);
    this.pending(null); this.patch({ error: null });
    if (pending.kind === "end" && pending.chatId === this.navigation.chatId) {
      if (retained) this.patch({ error: "旁聊已结束，新编辑的文字已保留，可复制取回" });
      else this.view(false);
    }
  }
  private pending(value: Pending | null): void {
    this.patch({ pending: value }); try { save(this.pendingKey, value); } catch { this.patch({ error: "操作回执无法保存，请勿刷新或重复发送" }); }
  }
  private failure(error: unknown, operationId?: string): void {
    if (operationId && this.state.pending?.operationId !== operationId) return;
    if (operationId && error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) this.pending(null);
    this.patch({ error: error instanceof Error ? error.message : "操作结果不明，请查询状态" });
    if (error instanceof HttpError && error.status === 409) void this.refresh();
  }
}
const models = new Map<string, SideChatModel>();
export function sideChatModel(key: string, api: SideChatApi, terminalId: string, panelId: string | null): SideChatModel {
  let model = models.get(key);
  if (!model) { model = new SideChatModel(key, api, terminalId, panelId); models.set(key, model); }
  model.updateApi(api, panelId); return model;
}
export function messageSequence(messages: SideChatMessage[]): string { return messages.map(message => message.id).join(":"); }
