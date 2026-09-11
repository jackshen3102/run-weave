import { batteryAlertLevel } from "@runweave/shared/device-status";
import type { DeviceMonitorService } from "./service";
import { DeviceSubscriptions } from "./subscriptions";
import { targetFor, updateAlerts } from "./alerts";
import { PushClientError } from "./push-client";
export class BatteryAlerts {
  private flight: Promise<void> | null = null;
  private again = false;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private stopped = false;
  private retryPersistenceAfter = 0;
  constructor(
    private monitor: DeviceMonitorService,
    readonly subscriptions: DeviceSubscriptions,
  ) {}
  start(): void {
    this.subscriptions.onChange = () => this.schedule();
    this.unsubscribe = this.monitor.subscribe(() => this.schedule());
  }
  schedule(): void {
    if (this.stopped) return;
    if (this.flight) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.flight = this.run()
      .catch(() => {
        this.subscriptions.failure = "提醒状态保存失败，发送已暂停";
        this.retryPersistenceAfter = Date.now() + 60_000;
      })
      .finally(() => {
        this.flight = null;
        if (this.stopped) return;
        if (this.again) {
          this.again = false;
          this.schedule();
          return;
        }
        const pending = Object.values(
          this.monitor.store.snapshot().deliveries,
        ).filter((d) => d.state === "pending");
        if (pending.length) {
          const next = Math.min(...pending.map((d) => d.nextAttemptAt));
          this.timer = setTimeout(
            () => this.schedule(),
            Math.max(
              1000,
              next - Date.now(),
              this.retryPersistenceAfter - Date.now(),
            ),
          );
          this.timer.unref();
        }
      });
  }
  private async run(): Promise<void> {
    if (!this.subscriptions.push) return;
    await this.subscriptions.reconcile();
    await this.monitor.store.update((data) => {
      const recipients = Object.values(data.subscriptions).filter(
        (s) => this.subscriptions.valid(s) && s.synced && !!s.confirmed,
      );
      updateAlerts(data, this.monitor.snapshot(), recipients);
    });
    for (const id of Object.keys(
      this.monitor.store.snapshot().endedCycles ?? {},
    )) {
      if (this.monitor.store.snapshot().syncedCycles?.[id]) continue;
      try {
        await this.subscriptions.push.completeCycle(id);
        await this.monitor.store.update((data) => {
          (data.syncedCycles ??= {})[id] = true;
        });
      } catch {
        /* Retry retirement after the next sample without blocking new cycles. */
      }
    }
    for (const item of Object.values(
      this.monitor.store.snapshot().deliveries,
    )) {
      if (
        this.stopped ||
        item.state !== "pending" ||
        item.nextAttemptAt > Date.now()
      )
        continue;
      const claim = await this.monitor.store.update((data) => {
        const current = data.deliveries[item.id];
        const snapshot = this.monitor.snapshot();
        const subscription = Object.values(data.subscriptions).find(
          (s) =>
            targetFor(s) === item.target &&
            s.synced &&
            !!s.confirmed &&
            this.subscriptions.valid(s),
        );
        if (!current || current.state !== "pending") return null;
        if (
          !subscription ||
          batteryAlertLevel(snapshot) !== item.level ||
          current.cycleId !== data.cycle?.id ||
          Date.now() - current.createdAt > 300_000
        ) {
          current.state = "cancelled";
          return null;
        }
        current.state = "sending";
        current.attempts += 1;
        return { subscription, snapshot };
      });
      if (!claim) continue;
      // Re-read the live binding after fsync and again after relay identity verification.
      const canSend = () => {
        const current =
          this.monitor.store.snapshot().subscriptions[claim.subscription.id];
        return (
          !this.stopped &&
          !!current &&
          this.subscriptions.valid(current) &&
          !!current.confirmed &&
          batteryAlertLevel(this.monitor.snapshot()) === item.level
        );
      };
      if (!canSend()) {
        await this.monitor.store.update((data) => {
          data.deliveries[item.id]!.state = "cancelled";
        });
        continue;
      }
      let result;
      try {
        result = await this.subscriptions.push.send(
          {
            notificationId: item.id,
            subscriptionId: claim.subscription.id,
            cycleId: item.cycleId,
            level: item.level,
            percent: claim.snapshot.battery.percent!,
            observedAt: claim.snapshot.observedAt!,
          },
          canSend,
        );
      } catch (error) {
        if (error instanceof PushClientError && error.status === 410)
          await this.subscriptions.disable(claim.subscription.id);
        result = { state: "failed" as const };
      }
      await this.monitor.store.update((data) => {
        const current = data.deliveries[item.id]!;
        if (
          result.state === "retry" &&
          current.attempts < 4 &&
          Date.now() - current.createdAt < 300_000
        ) {
          current.state = "pending";
          current.nextAttemptAt =
            Date.now() +
            Math.max(
              result.retryAfterMs ?? 0,
              [5_000, 30_000, 120_000][current.attempts - 1] ?? 120_000,
            );
        } else
          current.state = result.state === "retry" ? "failed" : result.state;
      });
    }
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.subscriptions.push?.dispose();
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.subscriptions.onChange = undefined;
    await this.flight;
  }
}
