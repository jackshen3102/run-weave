import { createHash } from "node:crypto";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import type { ScheduledTaskStore } from "../scheduled-tasks/storage/store";
import { logger } from "../logging/index";
import { DeviceSubscriptions } from "./subscriptions";
import { PushClientError } from "./push-client";
import type { ScheduledTaskDelivery } from "./types";

const INTERVAL_MS = 5_000;
const DELIVERY_WINDOW_MS = 300_000;

export class ScheduledTaskAlerts {
  private timer: NodeJS.Timeout | null = null;
  private flight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly runs: ScheduledTaskStore,
    private readonly subscriptions: DeviceSubscriptions,
  ) {}

  start(): void {
    if (this.timer || !this.subscriptions.push) return;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref();
    this.tick();
  }

  private tick(): void {
    if (this.stopped || this.flight) return;
    this.flight = this.run()
      .catch((error) => {
        logger.warn("scheduled-tasks.push.failed", {
          component: "scheduled-tasks",
          message: "Scheduled task notification pass failed",
          error,
        });
      })
      .finally(() => {
        this.flight = null;
      });
  }

  private async run(): Promise<void> {
    const snapshot = this.subscriptions.store.snapshot();
    const recipients = Object.values(snapshot.subscriptions).filter(
      (s) =>
        s.kind === "scheduled-task" &&
        this.subscriptions.valid(s) &&
        this.subscriptions.isSynced(s) &&
        s.confirmed &&
        s.confirmedAt,
    );
    const deliveries = snapshot.taskDeliveries ?? {};
    const pending = Object.values(deliveries).some(
      (d) =>
        (d.state === "pending" && d.nextAttemptAt <= Date.now()) ||
        d.state === "sending",
    );
    const expired = Object.values(deliveries).some(
      (d) => Date.now() - d.createdAt > 7 * 24 * 3600_000,
    );
    if (!recipients.length && !pending && !expired) return;
    const since = new Date(Date.now() - DELIVERY_WINDOW_MS).toISOString();
    const recent = recipients.length
      ? await this.runs.listRecentlyFinishedRuns(since)
      : [];
    const fresh = recent.some(
      (run) =>
        !!run.finishedAt &&
        recipients.some((subscription) => {
          if (
            Date.parse(subscription.confirmedAt!) > Date.parse(run.finishedAt!)
          )
            return false;
          const id = createHash("sha256")
            .update(`${run.id}:${subscription.id}`)
            .digest("hex");
          return !deliveries[id];
        }),
    );
    if (!fresh && !pending && !expired) return;
    await this.subscriptions.store.update((data) => {
      const deliveries = (data.taskDeliveries ??= {});
      for (const delivery of Object.values(deliveries)) {
        if (delivery.state === "sending") delivery.state = "unknown";
      }
      for (const run of recent) {
        if (!run.finishedAt) continue;
        for (const subscription of recipients) {
          if (
            Date.parse(subscription.confirmedAt!) > Date.parse(run.finishedAt)
          )
            continue;
          const id = createHash("sha256")
            .update(`${run.id}:${subscription.id}`)
            .digest("hex");
          deliveries[id] ??= createDelivery(id, run, subscription.id);
        }
      }
      for (const [id, delivery] of Object.entries(deliveries)) {
        if (Date.now() - delivery.createdAt > 7 * 24 * 3600_000)
          delete deliveries[id];
      }
    });
    for (const item of Object.values(
      this.subscriptions.store.snapshot().taskDeliveries ?? {},
    )) {
      if (
        this.stopped ||
        item.state !== "pending" ||
        item.nextAttemptAt > Date.now()
      )
        continue;
      const claim = await this.subscriptions.store.update((data) => {
        const delivery = data.taskDeliveries?.[item.id];
        const subscription = data.subscriptions[item.subscriptionId];
        if (!delivery || delivery.state !== "pending") return null;
        if (
          !subscription ||
          subscription.kind !== "scheduled-task" ||
          !this.subscriptions.valid(subscription) ||
          !this.subscriptions.isSynced(subscription) ||
          !subscription.confirmed ||
          Date.now() - delivery.createdAt > DELIVERY_WINDOW_MS
        ) {
          delivery.state = "cancelled";
          return null;
        }
        delivery.state = "sending";
        delivery.attempts += 1;
        return {
          subscriptionId: subscription.id,
          notification: delivery.notification,
        };
      });
      if (!claim) continue;
      const canSend = () => {
        const subscription =
          this.subscriptions.store.snapshot().subscriptions[
            claim.subscriptionId
          ];
        return (
          !this.stopped &&
          !!subscription &&
          subscription.kind === "scheduled-task" &&
          this.subscriptions.valid(subscription) &&
          this.subscriptions.isSynced(subscription) &&
          !!subscription.confirmed
        );
      };
      let result;
      try {
        result = await this.subscriptions.push!.send(
          {
            ...claim.notification,
            eventId: item.runId,
            subscriptionId: claim.subscriptionId,
          },
          canSend,
        );
      } catch (error) {
        if (error instanceof PushClientError && error.status === 410)
          await this.subscriptions.disable(claim.subscriptionId);
        result = { state: "failed" as const };
      }
      await this.subscriptions.store.update((data) => {
        const delivery = data.taskDeliveries?.[item.id];
        if (!delivery) return;
        if (
          result.state === "retry" &&
          delivery.attempts < 4 &&
          Date.now() - delivery.createdAt < DELIVERY_WINDOW_MS
        ) {
          delivery.state = "pending";
          delivery.nextAttemptAt =
            Date.now() +
            Math.max(
              result.retryAfterMs ?? 0,
              [5_000, 30_000, 120_000][delivery.attempts - 1] ?? 120_000,
            );
        } else {
          delivery.state = result.state === "retry" ? "failed" : result.state;
        }
      });
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flight;
  }
}

function createDelivery(
  id: string,
  run: ScheduledRun,
  subscriptionId: string,
): ScheduledTaskDelivery {
  const completed = run.status === "completed";
  return {
    id,
    runId: run.id,
    subscriptionId,
    notification: {
      category: completed ? "task.completed" : "task.failed",
      title: completed ? "定时任务已完成" : "定时任务失败",
      body: `${run.snapshot.name}：${completed ? "已完成" : "运行失败"}，请打开 Runweave 查看结果。`.slice(
        0,
        240,
      ),
      occurredAt: run.finishedAt!,
    },
    state: "pending",
    attempts: 0,
    createdAt: Date.parse(run.finishedAt!),
    nextAttemptAt: Date.now(),
  };
}
