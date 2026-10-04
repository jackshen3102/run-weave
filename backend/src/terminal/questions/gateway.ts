import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import type { AnswerTerminalQuestionRequest, TerminalQuestionRequest } from "@runweave/shared/terminal/questions";

const questionParams = z.object({
  threadId: z.string(), turnId: z.string(), itemId: z.string(), isBlocking: z.boolean(),
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(), isOther: z.boolean(), isSecret: z.boolean(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
  })).min(1).max(100).refine((questions) => new Set(questions.map((question) => question.id)).size === questions.length),
});

export class QuestionConflict extends Error {}

type Entry = {
  rawId: string | number;
  value: TerminalQuestionRequest;
  operation?: { id: string; fingerprint: string; };
};

export function answerFingerprint(answers: AnswerTerminalQuestionRequest["answers"]): string {
  return JSON.stringify(Object.keys(answers).sort().map((id) => [id, answers[id]!.answers]));
}

/** A borrowed connection: it cannot create turns, change settings or stop the executor. */
export class TerminalQuestionGateway {
  readonly generation = randomUUID();
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private entries = new Map<string, Entry>();
  private heartbeat: NodeJS.Timeout;
  private alive = true;
  connected = false;
  disposed = false;
  lastUsed = Date.now();

  constructor(readonly socketPath: string, readonly threadId: string) {
    this.socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 4000 });
    this.socket.on("message", (data) => {
      try { this.receive(JSON.parse(data.toString())); } catch { this.dispose(); }
    });
    this.socket.on("error", () => this.dispose());
    this.socket.on("close", () => this.dispose());
    this.socket.on("pong", () => { this.alive = true; });
    this.heartbeat = setInterval(() => {
      if (!this.alive || Date.now() - this.lastUsed > 15 * 60_000) { this.dispose(); return; }
      this.alive = false;
      if (this.socket.readyState === WebSocket.OPEN) this.socket.ping();
    }, 20_000);
    this.heartbeat.unref();
  }

  async join(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) { resolve(); return; }
      if (this.socket.readyState !== WebSocket.CONNECTING) { reject(new Error("executor disconnected")); return; }
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
      this.socket.once("close", () => reject(new Error("executor disconnected")));
    });
    await this.call("initialize", { clientInfo: { name: "runweave_terminal_questions", version: "1" }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: "initialized", params: {} }));
    // Never load a historical thread in a new executor. Require it already loaded here.
    let cursor: string | undefined;
    let found = false;
    for (let page = 0; page < 100; page++) {
      const result = await this.call("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) }) as { data: string[]; nextCursor?: string | null };
      if (result.data.includes(this.threadId)) { found = true; break; }
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    if (!found) throw new Error("original thread is not loaded");
    await this.call("thread/resume", { threadId: this.threadId, excludeTurns: true });
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("executor disconnected");
    this.connected = true;
  }

  private call(method: "initialize" | "thread/loaded/list" | "thread/resume", params: unknown): Promise<unknown> {
    const id = `rw-question-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("executor request timeout")); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.dispose();
      });
    });
  }

  private receive(message: Record<string, unknown>): void {
    if (!message.method) {
      const pending = typeof message.id === "string" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id as string);
      if (message.error) pending.reject(new Error("executor rejected request")); else pending.resolve(message.result);
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      const parsed = questionParams.safeParse(message.params);
      if (!parsed.success || parsed.data.threadId !== this.threadId || (typeof message.id !== "string" && typeof message.id !== "number")) return;
      if ([...this.entries.values()].some((entry) => entry.rawId === message.id)) return;
      const requestId = randomUUID();
      this.entries.set(requestId, { rawId: message.id, value: { ...parsed.data, requestId, generation: this.generation, state: "pending" } });
      // Retain current questions and a bounded set of receipts, never an unbounded history.
      if (this.entries.size > 100) {
        const old = [...this.entries].find(([, entry]) => entry.value.state === "expired" || entry.value.state === "resolved");
        if (old) this.entries.delete(old[0]); else this.dispose();
      }
      return;
    }
    const event = z.object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]).optional(), turn: z.object({ id: z.string() }).optional() }).safeParse(message.params);
    if (!event.success || event.data.threadId !== this.threadId) return;
    if (message.method === "serverRequest/resolved") {
      const entry = [...this.entries.values()].find((candidate) => candidate.rawId === event.data.requestId);
      if (entry) {
        // Resolution can mean cleanup or a computer answer; it is not proof our answer won.
        entry.value.state = entry.operation ? "resolved" : "expired";
      }
    }
    if (message.method === "turn/completed") {
      for (const entry of this.entries.values()) {
        if (entry.value.turnId === event.data.turn?.id && entry.value.isBlocking && entry.value.state !== "resolved") entry.value.state = "expired";
      }
    }
  }

  requests(): TerminalQuestionRequest[] { this.lastUsed = Date.now(); return [...this.entries.values()].map((entry) => ({ ...entry.value })); }

  answer(requestId: string, body: AnswerTerminalQuestionRequest): void {
    this.lastUsed = Date.now();
    const entry = this.entries.get(requestId);
    if (!this.connected || !entry || body.generation !== this.generation || body.threadId !== this.threadId ||
      body.turnId !== entry.value.turnId || body.itemId !== entry.value.itemId) throw new QuestionConflict("问题已变化，请刷新并回终端核对");
    const fingerprint = answerFingerprint(body.answers);
    if (entry.operation) {
      if (entry.operation.id === body.operationId && entry.operation.fingerprint === fingerprint) return;
      throw new QuestionConflict("该问题已提交，不能重复发送不同答案");
    }
    if (entry.value.state !== "pending") throw new QuestionConflict("该问题已结束，请回终端核对");
    const ids = entry.value.questions.map((question) => question.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(Object.keys(body.answers).sort()) ||
      ids.some((id) => body.answers[id]!.answers.length !== 1 || !body.answers[id]!.answers[0]!.trim())) throw new QuestionConflict("请回答全部问题");
    if (entry.value.questions.some((question) => question.options && !question.isOther &&
      !question.options.some((option) => option.label === body.answers[question.id]!.answers[0]))) throw new QuestionConflict("请选择问题提供的选项");
    entry.operation = { id: body.operationId, fingerprint };
    entry.value.state = "submitting";
    // Write once. Transport failure leaves this operation consumed; no automatic replay.
    this.socket.send(JSON.stringify({ id: entry.rawId, result: { answers: body.answers } }), (error) => { if (error) this.dispose(); });
  }

  dispose(): void {
    this.connected = false;
    this.disposed = true;
    clearInterval(this.heartbeat);
    for (const entry of this.entries.values()) if (entry.value.state !== "resolved") entry.value.state = "expired";
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("executor disconnected")); }
    this.pending.clear();
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}
