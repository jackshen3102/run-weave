import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { configuration } from "@runweave/config-node";
import type {
  TerminalPromptActionKind,
  TerminalQuestionNotificationResponse,
} from "@runweave/shared/terminal/questions";
import { PushClientError } from "../../device-monitor/push-client";
import type { DeviceSubscriptions } from "../../device-monitor/subscriptions";
import type {
  DeviceSubscription,
  TerminalQuestionLocation,
  TerminalQuestionPromptMeta,
} from "../../device-monitor/types";
import { logger } from "../../logging/index";
import type {
  OriginalTerminalQuestion,
  TerminalMobilePrompts,
  TerminalPromptObservation,
  TerminalQuestionEnd,
  TerminalQuestionOrigin,
} from "./origin";

const DISCOVERY_MS = 5_000;
const DEFAULT_PROMPT_SETTLE_MS = 250;
const DELIVERY_MS = 5 * 60_000;
const LOCATION_MS = 15 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const CONFIG_DOMAIN = "services.terminalQuestionNotifications";
const log = logger.child({ component: "terminal-question-notifications" });

type ActivePrompt = {
  eventId: string;
  terminalId: string;
  panelId: string;
  source: string;
  actionKind: TerminalPromptActionKind;
  dedupeKey: string;
  specificity: number;
  toolUseId?: string;
};

function questionEventId(hostId: string, origin: TerminalQuestionOrigin): string {
  return createHash("sha256").update(JSON.stringify([
    hostId, origin.terminalId, origin.panelId, origin.threadId, origin.turnId, origin.itemId,
  ])).digest("hex");
}

function promptEventId(hostId: string, terminalId: string, panelId: string, dedupeKey: string): string {
  return createHash("sha256").update(JSON.stringify([
    "prompt-v1", hostId, terminalId, panelId, dedupeKey,
  ])).digest("hex");
}

function slotKey(terminalId: string, panelId: string): string {
  return JSON.stringify([terminalId, panelId]);
}

export class TerminalQuestionNotifications implements TerminalMobilePrompts {
  private readonly discoveries = new Map<string, Promise<void>>();
  private readonly structuredSlots = new Map<string, Set<string>>();
  private readonly activePrompts = new Map<string, ActivePrompt>();
  private readonly observedSlots = new Set<string>();
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
      hasRemoteExecutor?(terminalId: string, panelId: string): Promise<boolean>;
      isSessionPanelRunning?(terminalId: string, panelId: string): boolean;
      isTerminalAgentActive?(terminalId: string, panelId: string): boolean;
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

  private enabled(): boolean {
    return !this.abort.signal.aborted &&
      this.config.get<boolean>(`${CONFIG_DOMAIN}.enabled`) === true &&
      Boolean(this.subscriptions.push);
  }

  private hasStructuredSlot(key: string): boolean {
    return (this.structuredSlots.get(key)?.size ?? 0) > 0;
  }

  observe(origin: TerminalQuestionOrigin): void {
    if (!this.enabled() || this.discoveries.size >= 128) return;
    const { hostId, terminalQuestions, subscriptions } = this.subscriptions.store.snapshot();
    const eventId = questionEventId(hostId, origin);
    if (this.discoveries.has(eventId) || Object.values(terminalQuestions ?? {}).some((entry) => entry.eventId === eventId)) return;
    if (!Object.values(subscriptions).some((value) => this.eligible(value))) return;
    const key = slotKey(origin.terminalId, origin.panelId);
    let slotSet = this.structuredSlots.get(key);
    if (!slotSet) this.structuredSlots.set(key, slotSet = new Set());
    slotSet.add(eventId);
    this.discoveries.set(eventId, this.discover(origin, eventId)
      .catch(() => {
        if (!this.abort.signal.aborted) log.warn("terminal-question.discovery.failed");
      })
      .finally(() => {
        this.discoveries.delete(eventId);
        const set = this.structuredSlots.get(key);
        set?.delete(eventId);
        if (set && set.size === 0) this.structuredSlots.delete(key);
      }));
  }

  observePrompt(input: TerminalPromptObservation): void {
    if (!this.enabled() || this.discoveries.size >= 128) return;
    const panelId = input.panelId ?? "";
    if (this.questions.isSessionPanelRunning && !this.questions.isSessionPanelRunning(input.terminalId, panelId)) return;
    const key = slotKey(input.terminalId, panelId);
    if (this.hasStructuredSlot(key)) return;
    const { hostId, terminalQuestions, subscriptions } = this.subscriptions.store.snapshot();
    if (!Object.values(subscriptions).some((value) => this.eligible(value))) return;
    if (Object.entries(terminalQuestions ?? {}).some(([ref, entry]) =>
      entry.origin.terminalId === input.terminalId && entry.origin.panelId === panelId &&
      !entry.endState && Date.now() < entry.expiresAt &&
      !this.subscriptions.store.snapshot().terminalQuestionPrompts?.[ref] &&
      this.questions.isPending(entry.origin))) {
      return;
    }
    const existing = this.activePrompts.get(key);
    if (existing && (existing.dedupeKey === input.dedupeKey || existing.specificity >= input.specificity)) {
      return;
    }
    const eventId = promptEventId(hostId, input.terminalId, panelId, input.dedupeKey);
    if (this.discoveries.has(eventId) || Object.values(terminalQuestions ?? {}).some((entry) => entry.eventId === eventId)) return;
    const active: ActivePrompt = {
      eventId,
      terminalId: input.terminalId,
      panelId,
      source: input.source,
      actionKind: input.actionKind,
      dedupeKey: input.dedupeKey,
      specificity: input.specificity,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    };
    this.observedSlots.add(key);
    this.activePrompts.set(key, active);
    const origin: TerminalQuestionOrigin = {
      terminalId: input.terminalId,
      panelId,
      threadId: input.source,
      turnId: input.actionKind,
      itemId: input.toolUseId ?? input.dedupeKey.slice(0, 128),
    };
    const meta: TerminalQuestionPromptMeta = {
      actionKind: input.actionKind,
      title: input.title,
      body: input.body,
    };
    const settleMs = Math.max(0, input.settleMs ?? DEFAULT_PROMPT_SETTLE_MS);
    this.discoveries.set(eventId, this.discoverPrompt(key, active, origin, meta, settleMs)
      .catch(() => {
        if (!this.abort.signal.aborted) log.warn("terminal-question.prompt-discovery.failed");
      })
      .finally(() => { this.discoveries.delete(eventId); }));
  }

  resolvePrompt(
    terminalId: string,
    panelId: string | null,
    state: TerminalQuestionEnd,
    match?: { toolUseId?: string; onlySource?: string },
  ): void {
    if (this.abort.signal.aborted) return;
    const normalizedPanel = panelId ?? "";
    const keys = normalizedPanel
      ? [slotKey(terminalId, normalizedPanel), slotKey(terminalId, "")]
      : [...this.activePrompts.keys()].filter((k) => this.activePrompts.get(k)?.terminalId === terminalId);
    for (const key of new Set(keys)) {
      this.observedSlots.add(key);
      const current = this.activePrompts.get(key);
      if (!current) continue;
      if (match?.onlySource && current.source !== match.onlySource) continue;
      if (match?.toolUseId && current.toolUseId && current.toolUseId !== match.toolUseId && current.actionKind !== "permission") {
        continue;
      }
      this.activePrompts.delete(key);
      this.recordEventEnd(current.eventId, state);
    }
  }

  hasActivePrompt(terminalId: string): boolean {
    if (this.abort.signal.aborted) return false;
    for (const [key, active] of this.activePrompts) {
      if (active.terminalId !== terminalId) continue;
      if (this.isPromptPending(key, active.eventId, {
        terminalId: active.terminalId,
        panelId: active.panelId,
        threadId: active.source,
        turnId: active.actionKind,
        itemId: active.toolUseId ?? active.dedupeKey.slice(0, 128),
      })) return true;
    }
    return false;
  }

  closeTerminal(terminalId: string): void {
    if (this.abort.signal.aborted) return;
    for (const [key, active] of this.activePrompts) {
      if (active.terminalId === terminalId) {
        this.observedSlots.add(key);
        this.activePrompts.delete(key);
        this.recordEventEnd(active.eventId, "closed");
      }
    }
    const { terminalQuestions, terminalQuestionPrompts } = this.subscriptions.store.snapshot();
    for (const [ref, entry] of Object.entries(terminalQuestions ?? {})) {
      if (entry.origin.terminalId === terminalId && terminalQuestionPrompts?.[ref] && !entry.endState) {
        this.recordEventEnd(entry.eventId, "closed");
      }
    }
  }

  recordEnd(origin: TerminalQuestionOrigin, state: TerminalQuestionEnd): void {
    if (this.abort.signal.aborted) return;
    const { hostId } = this.subscriptions.store.snapshot();
    this.recordEventEnd(questionEventId(hostId, origin), state);
  }

  private recordEventEnd(eventId: string, state: TerminalQuestionEnd): void {
    const { terminalQuestions } = this.subscriptions.store.snapshot();
    // Discovery may already be publishing the locator via the same store queue.
    if (!this.discoveries.has(eventId) && !Object.values(terminalQuestions ?? {}).some((entry) => entry.eventId === eventId)) return;
    const write = this.subscriptions.store.update((data) => {
      const current = Object.values(data.terminalQuestions ?? {}).find((entry) => entry.eventId === eventId);
      if (current && current.endState !== "resolved") current.endState = state;
    }).catch(() => { log.warn("terminal-question.receipt.save-failed"); })
      .finally(() => { if (this.endWrites.get(eventId) === write) this.endWrites.delete(eventId); });
    this.endWrites.set(eventId, write);
  }

  private isPromptPending(key: string, eventId: string, origin: TerminalQuestionOrigin): boolean {
    if (this.questions.isSessionPanelRunning && !this.questions.isSessionPanelRunning(origin.terminalId, origin.panelId)) {
      return false;
    }
    if (this.questions.isTerminalAgentActive && !this.questions.isTerminalAgentActive(origin.terminalId, origin.panelId)) {
      return false;
    }
    const active = this.activePrompts.get(key);
    if (active) return active.eventId === eventId;
    if (this.observedSlots.has(key)) return false;
    return true;
  }

  private async discoverPrompt(
    key: string,
    active: ActivePrompt,
    origin: TerminalQuestionOrigin,
    meta: TerminalQuestionPromptMeta,
    settleMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    if (settleMs > 0) {
      await delay(settleMs, undefined, { signal: this.abort.signal });
    }
    if (this.abort.signal.aborted || this.hasStructuredSlot(key) || this.activePrompts.get(key) !== active) return;
    if (this.questions.isSessionPanelRunning && !this.questions.isSessionPanelRunning(origin.terminalId, origin.panelId)) {
      if (this.activePrompts.get(key) === active) this.activePrompts.delete(key);
      return;
    }
    await this.subscriptions.store.update((data) => {
      if (this.abort.signal.aborted || this.hasStructuredSlot(key) || this.activePrompts.get(key) !== active) return;
      if (this.questions.isSessionPanelRunning && !this.questions.isSessionPanelRunning(origin.terminalId, origin.panelId)) return;
      const locations = data.terminalQuestions ??= {};
      const prompts = data.terminalQuestionPrompts ??= {};
      if (Object.values(locations).some((entry) => entry.eventId === active.eventId)) return;
      const deliveries: TerminalQuestionLocation["deliveries"] = {};
      for (const value of Object.values(data.subscriptions)) {
        if (!this.eligible(value) || !value.confirmedAt || Date.parse(value.confirmedAt) > startedAt) continue;
        deliveries[value.installationId] ??= {
          subscriptionId: value.id, sessionId: value.sessionId,
          state: "pending", attempts: 0, nextAttemptAt: Date.now(),
        };
      }
      if (Object.keys(deliveries).length) {
        const ref = randomUUID();
        locations[ref] = { eventId: active.eventId, origin, createdAt: startedAt, expiresAt: startedAt + LOCATION_MS, deliveries };
        prompts[ref] = meta;
      }
    });
    this.tick();
  }

  private fallbackCodexPrompt(origin: TerminalQuestionOrigin, eventId: string): void {
    const key = slotKey(origin.terminalId, origin.panelId);
    const set = this.structuredSlots.get(key);
    set?.delete(eventId);
    if (set?.size === 0) this.structuredSlots.delete(key);
    this.observePrompt({
      terminalId: origin.terminalId,
      panelId: origin.panelId,
      source: "codex",
      actionKind: "question",
      dedupeKey: `codex:question:${origin.threadId}:${origin.turnId}:${origin.itemId}`,
      title: "Codex 等你回答",
      body: "打开 Runweave 回到原终端确认选项。",
      specificity: 350,
      settleMs: DEFAULT_PROMPT_SETTLE_MS,
      toolUseId: origin.itemId,
    });
  }

  private async discover(origin: TerminalQuestionOrigin, eventId: string): Promise<void> {
    if (this.questions.hasRemoteExecutor && !(await this.questions.hasRemoteExecutor(origin.terminalId, origin.panelId))) {
      this.fallbackCodexPrompt(origin, eventId);
      return;
    }
    const startedAt = Date.now();
    const deadline = startedAt + DISCOVERY_MS;
    while (!this.abort.signal.aborted && Date.now() < deadline) {
      const check = await this.questions.readOriginal(origin);
      if (check.status === "unsupported") {
        this.fallbackCodexPrompt(origin, eventId);
        return;
      }
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
      const promptMeta = data.terminalQuestionPrompts?.[ref];
      const delivery = location?.deliveries[installationId];
      const subscription = delivery && data.subscriptions[delivery.subscriptionId];
      return location && delivery?.attempts && delivery.sessionId === sessionId && subscription?.sessionId === sessionId &&
        subscription.installationId === installationId && subscription.kind === "terminal-question" &&
        subscription.confirmed && this.subscriptions.valid(subscription) ? { location, promptMeta } : null;
    };
    const readLocation = async () => {
      const entry = authorized();
      if (!entry) return null;
      const write = this.endWrites.get(entry.location.eventId);
      if (!write) return entry;
      await write;
      return authorized();
    };
    const entry = await readLocation();
    if (!entry) return null;
    const { location, promptMeta } = entry;
    const { terminalId, panelId } = location.origin;
    const promptExtra = promptMeta
      ? { terminalOnly: true as const, actionKind: promptMeta.actionKind, title: promptMeta.title }
      : {};
    const target = { terminalId, panelId, ...promptExtra };
    const ended = (current: TerminalQuestionLocation) => {
      if (Date.now() >= current.expiresAt) return { status: "closed" as const, ...target };
      if (current.endState === "resolved") return { status: "closed" as const, ...target, resolved: true as const };
      if (current.endState === "closed") return { status: "closed" as const, ...target };
    };
    const knownEnd = ended(location);
    if (knownEnd) return knownEnd;
    if (promptMeta) {
      const key = slotKey(terminalId, panelId);
      if (!this.isPromptPending(key, location.eventId, location.origin)) {
        return { status: "closed", ...target };
      }
      return { status: "unavailable", ...target };
    }
    const check = await this.questions.readOriginal(location.origin);
    const latest = await readLocation();
    if (!latest) return null;
    const confirmedEnd = ended(latest.location);
    if (confirmedEnd) return confirmedEnd;
    if (check.status === "unsupported") return { status: "unavailable", terminalId, panelId };
    if (check.status !== "available") return { status: check.status, terminalId, panelId };
    const { request, value } = check;
    if (!request || request.state === "expired") return { status: "closed", terminalId, panelId };
    if (request.state === "resolved") return { status: "closed", terminalId, panelId, resolved: true };
    return { status: "pending", terminalId, panelId, questions: { ...value, requests: [request] } };
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
            if (data.terminalQuestionPrompts) delete data.terminalQuestionPrompts[ref];
            continue;
          }
          for (const delivery of Object.values(location.deliveries)) {
            if (delivery.state === "sending") delivery.state = "unknown";
          }
        }
        if (data.terminalQuestionPrompts) {
          for (const ref of Object.keys(data.terminalQuestionPrompts)) {
            if (!data.terminalQuestions?.[ref]) delete data.terminalQuestionPrompts[ref];
          }
          if (!Object.keys(data.terminalQuestionPrompts).length) delete data.terminalQuestionPrompts;
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
    const promptMeta = this.subscriptions.store.snapshot().terminalQuestionPrompts?.[ref];
    const key = slotKey(location.origin.terminalId, location.origin.panelId);
    const fresh = () => !this.abort.signal.aborted && this.config.get<boolean>(`${CONFIG_DOMAIN}.enabled`) === true &&
      Date.now() - location.createdAt < DELIVERY_MS;
    const eligible = (value?: DeviceSubscription) => !!value && value.sessionId === delivery.sessionId && this.eligible(value);
    const stillActive = () => {
      const latest = this.subscriptions.store.snapshot().terminalQuestions?.[ref];
      if (!latest || latest.endState) return false;
      return promptMeta
        ? this.isPromptPending(key, location.eventId, location.origin)
        : this.questions.isPending(location.origin);
    };
    const canSend = () => fresh() && this.subscriptions.push === push &&
      eligible(this.subscriptions.store.snapshot().subscriptions[delivery.subscriptionId]) && stillActive();
    const check = !promptMeta && fresh() && push && eligible(this.subscriptions.store.snapshot().subscriptions[delivery.subscriptionId])
      ? await this.questions.readOriginal(location.origin) : null;
    const claimed = await this.subscriptions.store.update((data) => {
      const current = data.terminalQuestions?.[ref]?.deliveries[installationId];
      if (!current || current.state !== "pending" || this.abort.signal.aborted) return false;
      const validQuestion = promptMeta
        ? stillActive()
        : check?.status === "available" && check.request?.state === "pending" && canSend();
      if (!validQuestion || !canSend()) {
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
        title: promptMeta?.title ?? "Codex 等你回答",
        body: promptMeta?.body ?? "打开 Runweave 查看待答问题。",
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
