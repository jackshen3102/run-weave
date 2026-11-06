import { createHash, randomUUID } from "node:crypto";
import type { RecordTerminalCompletionEventInput } from "../terminal/completion/events";
import type { TerminalMobileReplies } from "../terminal/completion/mobile-replies";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { formatReplyPreview } from "../terminal/completion/reply-preview";
import { logger } from "../logging/index";
import { targetFor } from "./alerts";
import { PushClientError } from "./push-client";
import type { DeviceSubscriptions } from "./subscriptions";
import type { DeviceMonitorData, DeviceSubscription } from "./types";

const INPUT_WINDOW_MS = 24 * 3600_000;
const DELIVERY_WINDOW_MS = 300_000;
const RETENTION_MS = 7 * 24 * 3600_000;
type ReplyState = NonNullable<DeviceMonitorData["terminalReplies"]>;

/** Input provenance and its outbox commit in the same durable store. */
export class TerminalReplyNotifications implements TerminalMobileReplies {
  private timer?: NodeJS.Timeout;
  private flight: Promise<void> | null = null;
  private stopped = false;

  constructor(private sessions: TerminalSessionManager, private subscriptions: DeviceSubscriptions) {}

  async start(): Promise<void> {
    if (this.subscriptions.store.snapshot().terminalReplies) {
      await this.subscriptions.store.update((data) => {
        for (const delivery of Object.values(data.terminalReplies!.deliveries)) {
          if (delivery.state === "sending") delivery.state = "unknown";
        }
      });
    }
    this.timer = setInterval(() => this.schedule(), 5_000);
    this.timer.unref();
    this.schedule();
  }

  async expectReply(terminalId: string, panelId: string | null, text: string, sessionId: string): Promise<string | undefined> {
    if (this.stopped) return;
    const recipients = Object.values(this.subscriptions.store.snapshot().subscriptions)
      .filter((s) => s.sessionId === sessionId && this.eligible(s));
    if (!recipients.length) return;
    const id = randomUUID();
    await this.subscriptions.store.update((data) => {
      const state = data.terminalReplies ??= { inputs: {}, turns: {}, deliveries: {} };
      const key = panelKey(terminalId, panelId);
      const inputs = (state.inputs[key] ?? []).filter((input) => input.expiresAt >= Date.now());
      state.inputs[key] = [...inputs, { id, hash: hashPrompt(text), sessionId, subscriptionIds: recipients.map((s) => s.id), expiresAt: Date.now() + INPUT_WINDOW_MS }].slice(-100);
    });
    return id;
  }

  async cancelInput(terminalId: string, panelId: string | null, id: string): Promise<void> {
    await this.subscriptions.store.update((data) => {
      const state = data.terminalReplies;
      const key = panelKey(terminalId, panelId);
      if (state?.inputs[key]) state.inputs[key] = state.inputs[key]!.filter((input) => input.id !== id);
    });
  }

  async beginTurn(terminalId: string, panelId: string | null, threadId: string | null, source: string, query?: string | null, startEventId?: string): Promise<void> {
    if (this.stopped || !this.subscriptions.store.snapshot().terminalReplies) return;
    await this.subscriptions.store.update((data) => {
      const state = data.terminalReplies!;
      this.prune(state);
      const key = panelKey(terminalId, panelId);
      const hash = hashPrompt(query ?? "");
      const previous = state.turns[key];
      const sameStart = previous?.source === source && previous.threadId === threadId &&
        (startEventId ? previous.startEventId === startEventId : !previous.completed && previous.hash === hash);
      // A duplicate hook must not consume an identical prompt queued for the next turn.
      if (sameStart && (previous.completed || previous.sessionId)) return;
      const inputs = state.inputs[key] ?? [];
      const index = query ? inputs.findIndex((input) => input.hash === hash) : -1;
      const input = index < 0 ? undefined : inputs.splice(index, 1)[0];
      if (sameStart) {
        if (input && !previous.completed) {
          previous.subscriptionIds = input.subscriptionIds;
          previous.sessionId = input.sessionId;
        }
        return;
      }
      if (!input && !previous) return;
      state.turns[key] = { id: randomUUID(), threadId, source, startEventId, hash,
        sessionId: input?.sessionId ?? null, subscriptionIds: input?.subscriptionIds ?? [], completed: false, startedAt: Date.now() };
    });
  }

  async complete(input: RecordTerminalCompletionEventInput): Promise<void> {
    if (this.stopped || input.completionReason !== "hook_stop" || input.rawHookEvent?.toLowerCase() !== "stop" ||
        !this.subscriptions.store.snapshot().terminalReplies) return;
    await this.subscriptions.store.update((data) => {
      const state = data.terminalReplies!;
      const turn = state.turns[panelKey(input.terminalSessionId, input.panelId ?? null)];
      if (!turn || turn.completed || turn.source !== input.source || (input.threadId && turn.threadId !== input.threadId)) return;
      turn.completed = true;
      const session = this.sessions.getSession(input.terminalSessionId);
      if (!session || !turn.sessionId) return;
      const recipients = new Map<string, DeviceSubscription>();
      for (const id of turn.subscriptionIds) {
        const subscription = data.subscriptions[id];
        if (subscription?.sessionId === turn.sessionId && this.eligible(subscription)) recipients.set(targetFor(subscription), subscription);
      }
      for (const [target, subscription] of recipients) {
        const id = createHash("sha256").update(`${input.terminalSessionId}:${turn.id}:${target}`).digest("hex");
        state.deliveries[id] ??= { id, terminalSessionId: session.id, panelId: input.panelId ?? null,
          sessionId: turn.sessionId, subscriptionId: subscription.id, notification: {
            title: `${session.alias || session.id} · 新回复`.slice(0, 120),
            body: (formatReplyPreview(input.summary) || "Agent 已回复，打开 Runweave 查看。").slice(0, 500),
            occurredAt: new Date().toISOString(),
          }, state: "pending", attempts: 0, createdAt: Date.now(), nextAttemptAt: Date.now() };
      }
      this.prune(state);
    });
    this.schedule();
  }

  private eligible(subscription: DeviceSubscription): boolean {
    return subscription.kind === "terminal-reply" && this.subscriptions.valid(subscription) &&
      this.subscriptions.isSynced(subscription) && !!subscription.confirmed;
  }

  private prune(state: ReplyState): void {
    for (const [key, inputs] of Object.entries(state.inputs)) {
      const live = inputs.filter((input) => input.expiresAt >= Date.now());
      if (live.length) state.inputs[key] = live;
      else delete state.inputs[key];
    }
    for (const [key, turn] of Object.entries(state.turns)) {
      if (Date.now() - turn.startedAt > RETENTION_MS) delete state.turns[key];
    }
    for (const [id, delivery] of Object.entries(state.deliveries)) {
      if (Date.now() - delivery.createdAt > RETENTION_MS) delete state.deliveries[id];
    }
  }

  private schedule(): void {
    if (this.stopped || this.flight) return;
    this.flight = this.deliver().catch((error) => {
      logger.warn("terminal-reply.push.failed", { error });
    }).finally(() => { this.flight = null; });
  }

  private async deliver(): Promise<void> {
    for (const item of Object.values(this.subscriptions.store.snapshot().terminalReplies?.deliveries ?? {})) {
      if (this.stopped || item.state !== "pending" || item.nextAttemptAt > Date.now()) continue;
      const claim = await this.subscriptions.store.update((data) => {
        const delivery = data.terminalReplies?.deliveries[item.id];
        if (!delivery || delivery.state !== "pending") return null;
        const subscription = data.subscriptions[delivery.subscriptionId];
        if (!subscription || subscription.sessionId !== delivery.sessionId || !this.eligible(subscription) || !this.targetExists(delivery) || Date.now() - delivery.createdAt > DELIVERY_WINDOW_MS) {
          delivery.state = "cancelled";
          return null;
        }
        delivery.state = "sending";
        delivery.attempts++;
        return { subscriptionId: subscription.id, notification: delivery.notification };
      });
      if (!claim) continue;
      const canSend = () => {
        const subscription = this.subscriptions.store.snapshot().subscriptions[claim.subscriptionId];
        return !this.stopped && subscription?.sessionId === item.sessionId && this.eligible(subscription) && this.targetExists(item);
      };
      let result;
      try {
        result = await this.subscriptions.push!.send({ ...claim.notification, subscriptionId: claim.subscriptionId,
          category: "terminal.reply", eventId: item.id }, canSend);
      } catch (error) {
        if (error instanceof PushClientError && error.status === 410) await this.subscriptions.disable(claim.subscriptionId);
        result = { state: "failed" as const };
      }
      await this.subscriptions.store.update((data) => {
        const delivery = data.terminalReplies!.deliveries[item.id]!;
        if (result.state === "retry" && delivery.attempts < 4 && Date.now() - delivery.createdAt < DELIVERY_WINDOW_MS) {
          delivery.state = "pending";
          delivery.nextAttemptAt = Date.now() + Math.max(result.retryAfterMs ?? 0, [5_000, 30_000, 120_000][delivery.attempts - 1] ?? 120_000);
        } else delivery.state = result.state === "retry" ? "failed" : result.state;
      });
    }
  }

  private targetExists(delivery: { terminalSessionId: string; panelId: string | null }): boolean {
    return !!this.sessions.getSession(delivery.terminalSessionId) &&
      (!delivery.panelId || this.sessions.getPanel(delivery.panelId)?.terminalSessionId === delivery.terminalSessionId);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.flight;
  }
}

function panelKey(terminalId: string, panelId: string | null): string {
  return JSON.stringify([terminalId, panelId]);
}

function hashPrompt(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim().slice(0, 8000)).digest("hex");
}
