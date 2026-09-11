import crypto from "node:crypto";
import path from "node:path";
import { logger } from "../logging/index";
import { resolveActivityStoragePaths } from "../utils/path";
import { ActivityQueryService } from "./database/service";
import { ActivityEventFactory } from "./recording/event-factory";
import { ActivityRecorder } from "./recording/recorder";
import { ActivityStore } from "./recording/store";

const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

export class ActivityRuntime {
  readonly recorder: ActivityRecorder;
  readonly queryService: ActivityQueryService;
  private timer: NodeJS.Timeout | null = null;
  private maintenance: Promise<void> | null = null;
  private stopped = false;
  private disposal: Promise<void> | null = null;
  private readonly maintenanceOwnerId: string;

  private constructor(
    readonly store: ActivityStore | null,
    readonly eventFactory: ActivityEventFactory,
    readonly instanceId: string,
  ) {
    this.recorder = new ActivityRecorder(store);
    this.queryService = new ActivityQueryService(store);
    this.maintenanceOwnerId = `${instanceId}:${crypto.randomUUID()}`;
  }

  static async create(input: {
    env: NodeJS.ProcessEnv;
    browserProfileDir: string;
    runtimeChannel: "stable" | "beta" | "dev";
  }): Promise<ActivityRuntime> {
    const { env, browserProfileDir, runtimeChannel } = input;
    const instanceId =
      env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() ||
      `backend:${process.pid}:${crypto
        .createHash("sha256")
        .update(browserProfileDir)
        .digest("hex")
        .slice(0, 12)}`;
    const eventFactory = new ActivityEventFactory({
      producerName: "runweave-backend",
      producerVersion: env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || "builtin",
      producerInstanceId: instanceId,
      runtimeChannel,
      runtimeSurface: "backend",
      sourceRevision: env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim(),
      backendProfileId: path.basename(browserProfileDir),
    });
    let store: ActivityStore | null = null;
    try {
      store = await ActivityStore.create({
        databasePath: resolveActivityStoragePaths(env).activityDatabaseFile,
        env,
      });
    } catch (error) {
      logger.warn("activity.initialize.failed", {
        component: "activity",
        message: "Activity is unavailable; Backend will continue without it",
        error,
      });
    }
    const runtime = new ActivityRuntime(store, eventFactory, instanceId);
    try {
      if (store) {
        await runtime.recorder.recordBatch([
          eventFactory.create({
            eventName: "producer.instance.started",
            payload: {
              pid: process.pid,
              releaseId: env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || null,
            },
          }),
        ]);
      }
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  start(): void {
    if (!this.store || this.stopped || this.timer) return;
    this.timer = setInterval(
      () => this.runMaintenance(),
      MAINTENANCE_INTERVAL_MS,
    );
    this.timer.unref();
    this.runMaintenance();
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.disposal = this.close();
    }
    return this.disposal;
  }

  private async close(): Promise<void> {
    await this.maintenance;
    await this.store?.close();
  }

  private runMaintenance(): void {
    if (!this.store || this.stopped || this.maintenance) return;
    this.maintenance = this.maintain(this.store)
      .catch((error) => {
        logger.warn("activity.maintenance.failed", {
          component: "activity",
          message: "Activity maintenance pass failed",
          error,
        });
      })
      .finally(() => {
        this.maintenance = null;
      });
  }

  private async maintain(store: ActivityStore): Promise<void> {
    while (!this.stopped) {
      const job = await store.runDelete(this.maintenanceOwnerId);
      if (!job || job.status === "completed" || job.status === "blocked") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (!this.stopped) await store.runRetention(this.maintenanceOwnerId);
  }
}
