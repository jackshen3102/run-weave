import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ResourceAlert,
  ResourceMonitorSettings,
  ResourceRemoteControl,
} from "@runweave/shared/resource-monitor";

const alertSchema = z
  .object({
    alertId: z.string(),
    hostId: z.string(),
    appKey: z.string(),
    appName: z.string(),
    ruleId: z.enum(["energy", "memory"]),
    firstAt: z.number(),
    lastAt: z.number(),
    mean: z.number(),
    sampleCount: z.number(),
    active: z.boolean(),
    snoozedUntil: z.number(),
    createdAt: z.number(),
  })
  .strict();
const schema = z
  .object({
    remoteControl: z
      .object({
        revision: z.number().int().nonnegative(),
        enabled: z.boolean(),
      })
      .strict()
      .default({ revision: 0, enabled: false }),
    settings: z
      .object({
        revision: z.number().int().nonnegative(),
        monitorEnabled: z.boolean(),
        alertsEnabled: z.boolean(),
      })
      .strict(),
    alerts: z.array(alertSchema).max(200),
    cooldowns: z.record(z.number()),
    snoozes: z.record(z.number()),
  })
  .strict();
export interface ResourceState {
  remoteControl: ResourceRemoteControl;
  settings: ResourceMonitorSettings;
  alerts: ResourceAlert[];
  cooldowns: Record<string, number>;
  snoozes: Record<string, number>;
}
export class ResourceMonitorStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private constructor(
    private file: string,
    private data: ResourceState,
  ) {}
  static async create(directory: string): Promise<ResourceMonitorStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "state.json");
    let data: ResourceState;
    try {
      data = schema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      // Preserve damaged state for diagnosis; failure disables only this capability.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      data = {
        remoteControl: { revision: 0, enabled: false },
        settings: { revision: 0, monitorEnabled: true, alertsEnabled: true },
        alerts: [],
        cooldowns: {},
        snoozes: {},
      };
    }
    const store = new ResourceMonitorStore(file, data);
    await store.update(() => undefined);
    return store;
  }
  snapshot(): ResourceState {
    return structuredClone(this.data);
  }
  update<T>(mutate: (draft: ResourceState) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error("资源监控已关闭"));
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.data);
        const result = mutate(next);
        schema.parse(next);
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
          await handle.close();
          await rename(temporary, this.file);
          this.data = next;
        } finally {
          await handle.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
        }
        return result;
      });
    this.tail = work;
    return work;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.tail.catch(() => undefined);
  }
}
