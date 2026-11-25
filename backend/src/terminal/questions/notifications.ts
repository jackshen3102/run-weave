import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { configuration } from "@runweave/config-node";
import type { TerminalQuestionNotificationResponse } from "@runweave/shared/terminal/questions";
import { PushClientError } from "../../device-monitor/push-client";
import type { DeviceSubscriptions } from "../../device-monitor/subscriptions";
import type { DeviceSubscription, TerminalQuestionLocation } from "../../device-monitor/types";
import { logger } from "../../logging/index";
import type { OriginalTerminalQuestion, TerminalQuestionEnd, TerminalQuestionOrigin } from "./origin";

const DISCOVERY_MS = 5_000;
const DELIVERY_MS = 5 * 60_000;
const LOCATION_MS = 15 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const CONFIG_DOMAIN = "services.terminalQuestionNotifications";
const log = logger.child({ component: "terminal-question-notifications" });

function questionEventId(hostId: string, origin: TerminalQuestionOrigin): string {
  return createHash("sha256").update(JSON.stringify([
    hostId, origin.terminalId, origin.panelId, origin.threadId, origin.turnId, origin.itemId,
  ])).digest("hex");
}

export class TerminalQuestionNotifications {
  private readonly discoveries = new Map<string, Promise<void>>();
  private readonly endWrites = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly config = configuration();
  private readonly disposeConfig = this.config.register(CONFIG_DOMAIN, () => {});
  private timer: NodeJS.Timeout;
  private flight?: Promise<void>;

  constructor(
    private readonly questions: {
      readOriginal(origin: TerminalQuestionOrigin): Promise<OriginalTerminalQuestion>;
      isPending(origin: TerminalQuestionOrigin): boolean;
    },
    private readonly subscriptions: DeviceSubscriptions,
  ) {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  private eligible(value: DeviceSubscription): boolean {
    return value.kind === "terminal-question" && !!value.confirmed &&
      this.subscriptions.valid(value) && this.subscriptions.isSynced(value);
  }

  observe(origin: TerminalQuestionOrigin): void {
    if (this.abort.signal.aborted || this.config.get<boolean>(`${CONFIG_DOMAIN}.enabled`) !== true ||
      !this.subscriptions.push || this.discoveries.size >= 128) return;
    const { hostId, terminalQuestions, subscriptions } = this.subscriptions.store.snapshot();
    const eventId = questionEventId(hostId, origin);
    if (this.discoveries.has(eventId) || Object.values(terminalQuestions ?? {}).some((entry) => entry.eventId === eventId)) return;
    if (!Object.values(subscriptions).some((value) => this.eligible(value))) return;
    this.discoveries.set(eventId, this.discover(origin, eventId)
      .catch(() => {
        if (!this.abort.signal.aborted) log.warn("terminal-question.discovery.failed");
      })
      .finally(() => { this.discoveries.delete(eventId); }));
  }

  recordEnd(origin: TerminalQuestionOrigin, state: TerminalQuestionEnd): void {
    if (this.abort.signal.aborted) return;
    const { hostId, terminalQuestions } = this.subscriptions.store.snapshot();
    const eventId = questionEventId(hostId, origin);
    // Discovery may already be publishing the locator via the same store queue.
    if (!this.discoveries.has(eventId) && !Object.values(terminalQuestions ?? {}).some((entry) => entry.eventId === eventId)) return;
    const write = this.subscriptions.store.update((data) => {
      const current = Object.values(data.terminalQuestions ?? {}).find((entry) => entry.eventId === eventId);
      if (current && current.endState !== "resolved") current.endState = state;
    }).catch(() => { log.warn("terminal-question.receipt.save-failed"); })
      .finally(() => { if (this.endWrites.get(eventId) === write) this.endWrites.delete(eventId); });
    this.endWrites.set(eventId, write);
  }

  private async discover(origin: TerminalQuestionOrigin, eventId: string): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + DISCOVERY_MS;
    while (!this.abort.signal.aborted && Date.now() < deadline) {
      const check = await this.questions.readOriginal(origin);
      if (check.status === "closed" || (check.status === "available" && check.request && check.request.state !== "pending")) return;
      if (check.status === "available" && check.request) {
        await this.subscriptions.store.update((data) => {
          if (this.abort.signal.aborted || Date.now() >= deadline || !this.questions.isPending(origin)) return;
          const locations = data.terminalQuestions ??= {};
          if (Object.values(locations).some((entry) => entry.eventId === eventId)) return;
          const deliveries: TerminalQuestionLocation["deliveries"] = {};
          for (const value of Object.values(data.subscriptions)) {
            if (!this.eligible(value) || !value.confirmedAt || Date.parse(value.confirmedAt) > startedAt) continue;
            deliveries[value.installationId] ??= {
              subscriptionId: value.id, sessionId: value.sessionId,
              state: "pending", attempts: 0, nextAttemptAt: Date.now(),
            };
          }
          if (Object.keys(deliveries).length) {
            locations[randomUUID()] = { eventId, origin, createdAt: startedAt, expiresAt: startedAt + LOCATION_MS, deliveries };
          }
        });
        this.tick();
        return;
      }
      await delay(200, undefined, { signal: this.abort.signal });
    }
  }

  async resolve(ref: string, installationId: string, sessionId: string): Promise<TerminalQuestionNotificationResponse | null> {
    const authorized = () => {
      const data = this.subscriptions.store.snapshot();
      const location = data.terminalQuestions?.[ref];
      const delivery = location?.deliveries[installationId];
      const subscription = delivery && data.subscriptions[delivery.subscriptionId];
      return location && delivery?.attempts && delivery.sessionId === sessionId && subscription?.sessionId === sessionId &&
        subscription.installationId === installationId && subscription.kind === "terminal-question" &&
        subscription.confirmed && this.subscriptions.valid(subscription) ? location : null;
    };
    const readLocation = async () => {
      const location = authorized();
      if (!location) return null;
      const write = this.endWrites.get(location.eventId);
      if (!write) return location;
      await write;
      return authorized();
    };
    const location = await readLocation();
    if (!location) return null;
    const { terminalId, panelId } = location.origin;
    const target = { terminalId, panelId };
    const ended = (current: TerminalQuestionLocation) => {
      if (Date.now() >= current.expiresAt) return { status: "closed" as const, ...target };
      if (current.endState === "resolved") return { status: "closed" as const, ...target, resolved: true as const };
      if (current.endState === "closed") return { status: "closed" as const, ...target };
    };
    const knownEnd = ended(location);
    if (knownEnd) return knownEnd;
    const check = await this.questions.readOriginal(location.origin);
    const latest = await readLocation();
    if (!latest) return null;
    const confirmedEnd = ended(latest);
    if (confirmedEnd) return confirmedEnd;
    if (check.status !== "available") return { status: check.status, ...target };
    const { request, value } = check;
    if (!request || request.state === "expired") return { status: "closed", ...target };
    if (request.state === "resolved") return { status: "closed", ...target, resolved: true };
    return { status: "pending", ...target, questions: { ...value, requests: [request] } };
  }

  private tick(): void {
    if (this.abort.signal.aborted || this.flight) return;
    const locations = this.subscriptions.store.snapshot().terminalQuestions ?? {};
    const now = Date.now();
    if (!Object.values(locations).some((location) =>
      now - location.createdAt > RETENTION_MS || Object.values(location.deliveries).some((delivery) =>
        delivery.state === "sending" || (delivery.state === "pending" && delivery.nextAttemptAt <= now)))) return;
    this.flight = this.deliver(locations)
      .catch(() => { log.warn("terminal-question.delivery.failed"); })
      .finally(() => { this.flight = undefined; });
  }

  private async deliver(locations: Record<string, TerminalQuestionLocation>): Promise<void> {
    if (Object.values(locations).some((location) => Date.now() - location.createdAt > RETENTION_MS ||
      Object.values(location.deliveries).some((delivery) => delivery.state === "sending"))) {
      await this.subscriptions.store.update((data) => {
        for (const [ref, location] of Object.entries(data.terminalQuestions ?? {})) {
          if (Date.now() - location.createdAt > RETENTION_MS) {
            delete data.terminalQuestions![ref];
            continue;
          }
          for (const delivery of Object.values(location.deliveries)) {
            if (delivery.state === "sending") delivery.state = "unknown";
          }
        }
      });
    }
    for (const [ref, location] of Object.entries(locations)) {
      for (const [installationId, delivery] of Object.entries(location.deliveries)) {
        if (this.abort.signal.aborted) return;
        if (delivery.state === "pending" && delivery.nextAttemptAt <= Date.now()) {
          await this.send(ref, installationId, location, delivery);
        }
      }
    }
  }

  private async send(ref: string, installationId: string, location: TerminalQuestionLocation, delivery: TerminalQuestionLocation["deliveries"][string]): Promise<void> {
    const push = this.subscriptions.push;
    const fresh = () => !this.abort.signal.aborted && this.config.get<boolean>(`${CONFIG_DOMAIN}.enabled`) === true &&
      Date.now() - location.createdAt < DELIVERY_MS;
    const eligible = (value?: DeviceSubscription) => !!value && value.sessionId === delivery.sessionId && this.eligible(value);
    const canSend = () => fresh() && this.subscriptions.push === push &&
      eligible(this.subscriptions.store.snapshot().subscriptions[delivery.subscriptionId]) && this.questions.isPending(location.origin);
    const check = fresh() && push && eligible(this.subscriptions.store.snapshot().subscriptions[delivery.subscriptionId])
      ? await this.questions.readOriginal(location.origin) : null;
    const claimed = await this.subscriptions.store.update((data) => {
      const current = data.terminalQuestions?.[ref]?.deliveries[installationId];
      if (!current || current.state !== "pending" || this.abort.signal.aborted) return false;
      if (check?.status !== "available" || check.request?.state !== "pending" || !canSend()) {
        current.state = "cancelled";
        return false;
      }
      current.state = "sending";
      current.attempts += 1;
      return true;
    });
    if (!claimed) return;
    let result;
    try {
      result = await push!.send({
        subscriptionId: delivery.subscriptionId, eventId: location.eventId, category: "terminal.question",
        title: "Codex 等你回答", body: "打开 Runweave 查看待答问题。",
        occurredAt: new Date(location.createdAt).toISOString(),
        target: { resourceType: "terminal-question", resourceId: ref },
      }, canSend);
    } catch (error) {
      if (error instanceof PushClientError && error.status === 410) await this.subscriptions.disable(delivery.subscriptionId);
      result = { state: "failed" as const };
    }
    await this.subscriptions.store.update((data) => {
      const current = data.terminalQuestions![ref]!.deliveries[installationId]!;
      if (result.state === "retry" && current.attempts < 4 && fresh()) {
        current.state = "pending";
        current.nextAttemptAt = Date.now() + Math.max(result.retryAfterMs ?? 0, [5_000, 30_000, 120_000][current.attempts - 1]!);
      } else {
        current.state = result.state === "retry" ? "failed" : result.state;
      }
    });
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    this.disposeConfig();
    await Promise.allSettled([this.flight, ...this.discoveries.values(), ...this.endWrites.values()]);
  }
}
