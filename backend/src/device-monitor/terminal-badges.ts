import type { TerminalUnreadSnapshot } from "@runweave/shared/terminal-unread";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { DeviceSubscriptions } from "./subscriptions";

/** Absolute snapshots make retries and lost responses safe: no increment/decrement operations. */
export class TerminalBadges {
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private flight: Promise<void> | null = null;
  private stopped = false;
  private again = false;
  private sent = new Map<string, string>();

  constructor(
    private sessions: TerminalSessionManager,
    private events: TerminalEventService,
    private subscriptions: DeviceSubscriptions,
  ) {}

  async snapshot(): Promise<TerminalUnreadSnapshot> {
    const store = this.subscriptions.store;
    const count = () => this.sessions.listSessions().filter(
      (s) => s.completionRevision > s.acknowledgedCompletionRevision,
    ).length;
    if (store.snapshot().unread?.count !== count()) {
      await store.update((data) => {
        const current = count();
        if (data.unread?.count !== current) {
          data.unread = { revision: (data.unread?.revision ?? 0) + 1, count: current };
        }
      });
    }
    const data = store.snapshot();
    return { hostId: data.hostId, ...data.unread! };
  }

  start(): void {
    this.unsubscribe = this.events.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.schedule(), 2_000);
    this.timer.unref();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.flight) { this.again = true; return; }
    this.flight = this.sync().catch(() => undefined).finally(() => {
      this.flight = null;
      if (this.again) { this.again = false; this.schedule(); }
    });
  }

  private async sync(): Promise<void> {
    const snapshot = await this.snapshot();
    const push = this.subscriptions.push;
    if (!push || this.stopped) return;
    const values = Object.values(this.subscriptions.store.snapshot().subscriptions);
    const active = new Set(values.filter((s) => s.enabled).map((s) => s.id));
    for (const id of this.sent.keys()) if (!active.has(id)) this.sent.delete(id);
    for (const s of values) {
      if (this.stopped) return;
      if (s.kind !== "terminal-unread" || !this.subscriptions.valid(s) ||
          !s.confirmed || !this.subscriptions.isSynced(s)) continue;
      const key = `${push.url}:${s.version}:${snapshot.revision}`;
      if (this.sent.get(s.id) === key) continue;
      await push.updateBadge(s.id, { count: snapshot.count, revision: snapshot.revision });
      this.sent.set(s.id, key);
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    await this.flight;
  }
}
