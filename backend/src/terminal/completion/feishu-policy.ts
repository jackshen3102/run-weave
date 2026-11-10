import { createHash, randomUUID } from "node:crypto";
import type { ClaudeHookContext, TerminalFeishuDecision, TerminalCompletionEvent } from "@runweave/shared/terminal/completion";
import type { FeishuNotificationState } from "./feishu-state";

const MIN_DURATION_MS = 60_000;
const GRACE_MS = 30_000;
const INPUT_TTL_MS = 120_000;

interface PolicySession {
  status: "running" | "exited";
  acknowledgedCompletionRevision: number;
  feishuNotificationState?: FeishuNotificationState;
}

type CompletionInput = Pick<TerminalCompletionEvent,
  "terminalSessionId" | "source" | "completionReason" | "rawHookEvent" | "panelId" | "threadId">;

export class TerminalFeishuPolicy {
  constructor(
    private readonly getSession: (id: string) => PolicySession | undefined,
    private readonly save: (id: string, state: FeishuNotificationState) => Promise<void>,
    private readonly panelExists: (id: string) => boolean,
  ) {}

  async expectReply(id: string, panelId: string | null, text: string, operationId: string): Promise<void> {
    const state = this.state(id);
    if (!state) return;
    state.inputs[panelId ?? ""] = { hash: hashPrompt(text), expiresAt: Date.now() + INPUT_TTL_MS, operationId };
    await this.save(id, state);
  }

  async beginTurn(id: string, panelId: string | null, threadId: string | null, source: string, query?: string | null, startEventId?: string): Promise<void> {
    const state = this.state(id);
    if (!state) return;
    const key = panelId ?? "";
    const pending = state.inputs[key];
    const feishuReply = Boolean(pending && pending.expiresAt >= Date.now() && query && pending.hash === hashPrompt(query));
    if (pending && (feishuReply || pending.expiresAt < Date.now())) delete state.inputs[key];
    const previous = state.turns[key];
    const sameStart = previous && previous.threadId === threadId && previous.source === source &&
      (startEventId ? previous.startEventId === startEventId : !previous.completed);
    // Both hook transports share an event ID; Pi uses its provider run ID.
    // A distinct prompt starts a fresh clock, including after interruption.
    if (sameStart) {
      if (!feishuReply || previous.feishuReply) return;
      previous.feishuReply = true;
    } else {
      state.turns[key] = { id: randomUUID(), startEventId, threadId, source, startedAt: Date.now(), completed: false, feishuReply };
    }
    await this.save(id, state);
  }

  async complete(input: CompletionInput, revision: number, expectedTurnId?: string): Promise<void> {
    const state = this.state(input.terminalSessionId);
    if (!state) return;
    const panelId = input.panelId ?? null;
    const turn = state.turns[panelId ?? ""];
    const matches = Boolean(turn && (!expectedTurnId || turn.id === expectedTurnId) && turn.source === input.source &&
      (!input.threadId || input.threadId === turn.threadId));
    const attention = input.completionReason === "notify";
    const mainStop = input.completionReason === "hook_stop" && input.rawHookEvent?.toLowerCase() === "stop";
    const bypass = attention || Boolean(matches && turn?.feishuReply);
    const now = Date.now();
    // Claude's native idle notification confirms a prior Stop. Measure work at
    // Stop, so the native idle delay cannot turn a short task into a long one.
    const finishedAt = input.source === "claude" ? turn?.claude?.stop?.at ?? now : now;
    if (attention || (mainStop && matches && turn && !turn.completed &&
      (bypass || finishedAt - turn.startedAt >= MIN_DURATION_MS))) {
      state.completions[String(revision)] = {
        panelId, turnId: matches ? turn!.id : null, dueAt: now + (bypass ? 0 : GRACE_MS),
        bypass, seen: false, claimed: false,
      };
    }
    if (mainStop && matches && turn) turn.completed = true;
    // Only pending notifications within the latest 200 revisions can be sent.
    for (const key of Object.keys(state.completions)) {
      if (Number(key) <= revision - 200) delete state.completions[key];
    }
    await this.save(input.terminalSessionId, state);
  }

  async observeClaudeHook(input: CompletionInput & { claude: ClaudeHookContext; summary?: string | null }): Promise<
    { settled: true; summary: string; turnId: string } | { settled: false; notificationId?: string }
  > {
    const state = this.state(input.terminalSessionId);
    if (!state || !input.threadId) return { settled: false };
    const panelId = input.panelId ?? null;
    const key = panelId ?? "";
    const event = input.rawHookEvent?.toLowerCase().replace(/[_\s-]/g, "");
    const { instanceId, eventId, query, notificationType } = input.claude;
    if (event === "userpromptsubmit") {
      await this.beginTurn(input.terminalSessionId, panelId, input.threadId, "claude", query, eventId);
      state.turns[key]!.claude = { instanceId };
      await this.save(input.terminalSessionId, state);
      return { settled: false };
    }
    const turn = state.turns[key];
    if (turn?.source !== "claude" || turn.threadId !== input.threadId || turn.claude?.instanceId !== instanceId) return { settled: false };
    const native = turn.claude;
    if (event === "sessionend") {
      delete state.turns[key];
    } else if (input.completionReason === "notify") {
      delete native.stop;
      if (native.attentionPending) return { settled: false };
      native.attentionPending = true;
      const notificationId = await this.attention(input.terminalSessionId, panelId);
      return { settled: false, ...(notificationId ? { notificationId } : {}) };
    } else if (!turn.completed) {
      if (["pretooluse", "posttooluse", "posttoolusefailure", "stopfailure"].includes(event ?? "")) {
        native.attentionPending = false;
        delete native.stop;
      }
      if (event === "stop" && input.summary && !native.stop?.settled && native.stop?.summary !== input.summary) {
        native.stop = { at: Date.now(), summary: input.summary, settled: false };
      }
      if (event === "notification" && notificationType === "idle_prompt" && native.stop && !native.stop.settled) {
        native.stop.settled = true; // Claim before publishing; unknown outcomes never replay.
        await this.save(input.terminalSessionId, state);
        return { settled: true, summary: native.stop.summary, turnId: turn.id };
      }
    }
    await this.save(input.terminalSessionId, state);
    return { settled: false };
  }

  async viewed(id: string, revision: number, panelIds: string[]): Promise<void> {
    const state = this.state(id);
    if (!state) return;
    let changed = false;
    for (const [key, value] of Object.entries(state.completions)) {
      if (Number(key) <= revision && !value.seen && (!value.panelId || panelIds.includes(value.panelId))) {
        value.seen = true;
        changed = true;
      }
    }
    if (changed) await this.save(id, state);
  }

  async attention(id: string, panelId: string | null): Promise<string | null> {
    const state = this.state(id);
    if (!state) return null;
    const notificationId = randomUUID();
    state.completions[notificationId] = {
      panelId, turnId: null, dueAt: Date.now(), bypass: true, seen: false, claimed: false,
    };
    for (const key of Object.keys(state.completions).slice(0, -200)) delete state.completions[key];
    await this.save(id, state);
    return notificationId;
  }

  async decide(id: string, revision: number | string, claim: boolean): Promise<TerminalFeishuDecision> {
    const session = this.getSession(id);
    const state = session?.feishuNotificationState;
    const completion = state && Object.hasOwn(state.completions, String(revision))
      ? state.completions[String(revision)] : undefined;
    if (!session || !state || !completion) return { action: "skip", reason: "not_eligible" };
    if (completion.panelId && !this.panelExists(completion.panelId)) return { action: "skip", reason: "panel_removed" };
    if (completion.claimed) return { action: "skip", reason: "already_claimed" };
    if (!completion.bypass) {
      if (completion.seen || session.acknowledgedCompletionRevision >= Number(revision)) return { action: "skip", reason: "viewed" };
      if (session.status !== "running" || state.turns[completion.panelId ?? ""]?.id !== completion.turnId) return { action: "skip", reason: "superseded" };
    }
    const delayMs = completion.dueAt - Date.now();
    if (delayMs > 0) return { action: "wait", delayMs };
    if (claim) {
      // Claim before sending. Unknown transport outcomes are never auto-replayed.
      completion.claimed = true;
      await this.save(id, state);
    }
    return { action: "send" };
  }

  private state(id: string): FeishuNotificationState | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;
    return session.feishuNotificationState ??= { turns: {}, inputs: {}, completions: {} };
  }
}

function hashPrompt(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim().slice(0, 8000)).digest("hex");
}
