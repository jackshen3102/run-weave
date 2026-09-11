import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  acquireBackendProfileLock,
  type BackendProfileLock,
} from "../server/profile-lock";
import { deviceMonitorSchema } from "./schema";
import type { DeviceMonitorData } from "./types";

export class DeviceMonitorStore {
  private closing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    private file: string,
    private lock: BackendProfileLock,
    private data: DeviceMonitorData,
  ) {}

  static async create(directory: string): Promise<DeviceMonitorStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireBackendProfileLock({
      profileDir: directory,
      port: null,
      host: undefined,
    });
    try {
      const file = path.join(directory, "state.json");
      let data: DeviceMonitorData;
      try {
        data = deviceMonitorSchema.parse(
          JSON.parse(await readFile(file, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = {
          schemaVersion: 1,
          hostId: randomUUID(),
          cycle: null,
          subscriptions: {},
          deliveries: {},
        };
      }
      const store = new DeviceMonitorStore(file, lock, data);
      await store.update(() => undefined);
      return store;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  snapshot(): DeviceMonitorData {
    return structuredClone(this.data);
  }

  update<T>(mutate: (draft: DeviceMonitorData) => T): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Device monitor store is closed"));
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.data);
        const result = mutate(next);
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
          await handle.close();
          await rename(temporary, this.file);
          this.data = next;
          return result;
        } finally {
          await handle.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
        }
      });
    this.tail = work;
    return work;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail.catch(() => undefined);
    await this.lock.release();
  }
}
