import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerEventEnvelope,
  AppServerSyncStatusResponse,
  AppServerThreadRef,
} from "@runweave/shared";

export interface AppServerCloudSyncSimOptions {
  syncDir: string;
  stateDir: string;
  instanceId: string;
  version: string;
}

export interface AppServerCloudSyncPayload {
  events: AppServerEventEnvelope[];
  threads: AppServerThreadRef[];
  threadChanges: AppServerThreadRef[];
}

interface UploadCursor {
  latestSyncedEventId: string | null;
  updatedAt: string | null;
}

export class AppServerCloudSyncSim {
  private latestSyncedEventId: string | null = null;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: AppServerCloudSyncSimOptions) {}

  async initialize(): Promise<void> {
    try {
      await this.ensureDirectories();
      const cursor = await readJsonFile<UploadCursor>(
        this.cursorPath,
        isUploadCursor,
      );
      this.latestSyncedEventId = cursor?.latestSyncedEventId ?? null;
      this.lastSyncAt = cursor?.updatedAt ?? null;
      await this.writeManifest();
    } catch (error) {
      this.lastError = String(error);
    }
  }

  async sync(payload: AppServerCloudSyncPayload): Promise<void> {
    try {
      await this.ensureDirectories();
      const eventsToSync = payload.events.filter(
        (event) => Number(event.id) > Number(this.latestSyncedEventId ?? 0),
      );
      if (eventsToSync.length > 0) {
        await appendFile(
          this.eventsMirrorPath,
          eventsToSync.map((event) => JSON.stringify(event)).join("\n") + "\n",
          "utf8",
        );
        this.latestSyncedEventId = eventsToSync.at(-1)?.id ?? null;
      }
      await this.appendProjectionChanges(
        payload.threadChanges,
        this.threadProjectionPath,
      );
      await writeJsonFile(this.latestThreadsPath, payload.threads);
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      await writeJsonFile(this.cursorPath, {
        latestSyncedEventId: this.latestSyncedEventId,
        updatedAt: this.lastSyncAt,
      });
      await this.writeManifest();
    } catch (error) {
      this.lastError = String(error);
      try {
        await this.writeManifest();
      } catch {
        // If the sync directory is unavailable, the HTTP event path must still
        // succeed. The next write will retry the whole sync from the cursor.
      }
    }
  }

  getStatus(): AppServerSyncStatusResponse {
    return {
      enabled: true,
      syncDir: this.options.syncDir,
      latestSyncedEventId: this.latestSyncedEventId,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  private async appendProjectionChanges<T>(
    changes: T[],
    filePath: string,
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }
    await appendFile(
      filePath,
      changes.map((change) => JSON.stringify(change)).join("\n") + "\n",
      "utf8",
    );
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.options.syncDir, "events"), { recursive: true }),
      mkdir(path.join(this.options.syncDir, "projections"), {
        recursive: true,
      }),
      mkdir(path.join(this.options.syncDir, "cursors"), { recursive: true }),
      mkdir(path.join(this.options.syncDir, "manifests"), { recursive: true }),
    ]);
  }

  private async writeManifest(): Promise<void> {
    await writeJsonFile(this.manifestPath, {
      schemaVersion: 1,
      appServerInstanceId: this.options.instanceId,
      appServerVersion: this.options.version,
      stateDir: this.options.stateDir,
      syncDir: this.options.syncDir,
      latestSyncedEventId: this.latestSyncedEventId,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    });
  }

  private get eventsMirrorPath(): string {
    return path.join(this.options.syncDir, "events", "app-server-events.jsonl");
  }

  private get threadProjectionPath(): string {
    return path.join(this.options.syncDir, "projections", "threads.jsonl");
  }

  private get latestThreadsPath(): string {
    return path.join(this.options.syncDir, "projections", "latest-threads.json");
  }

  private get cursorPath(): string {
    return path.join(this.options.syncDir, "cursors", "upload-cursor.json");
  }

  private get manifestPath(): string {
    return path.join(this.options.syncDir, "manifests", "sync-manifest.json");
  }
}

async function readJsonFile<T>(
  filePath: string,
  predicate: (value: unknown) => value is T,
): Promise<T | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return predicate(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isUploadCursor(value: unknown): value is UploadCursor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.latestSyncedEventId === null ||
      typeof record.latestSyncedEventId === "string") &&
    (record.updatedAt === null || typeof record.updatedAt === "string")
  );
}
