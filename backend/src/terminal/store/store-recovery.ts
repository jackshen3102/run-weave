import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { logger } from "../../logging/index";

const storeLogger = logger.child({ component: "terminal-session-store" });

const BACKUP_DIR_NAME = "terminal-session-backups";
const SNAPSHOT_DIR_NAME = "terminal-session-snapshots";
const FILE_PREFIX = "session-";
const FILE_SUFFIX = ".json";

export const MAX_CORRUPT_STORE_BACKUPS = 3;
export const MAX_STORE_SNAPSHOTS = 48;
export const STORE_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_SUPPORTED_STORE_SCHEMA_VERSION = 1;

const ARRAY_COLLECTION_KEYS = [
  "projects",
  "sessions",
  "panels",
  "panelWorkspaces",
  "recentAgentActivities",
] as const;

export interface StructuralStoreShape {
  projects?: ReadonlyArray<{ id: string }>;
  sessions?: ReadonlyArray<{
    id: string;
    projectId?: string;
    cwd?: string;
    status?: string;
  }>;
  panels?: ReadonlyArray<{
    id: string;
    terminalSessionId: string;
  }>;
}

export type StoreLoadResult<T> =
  | { status: "missing" }
  | { status: "ok"; data: T }
  | { status: "corrupted"; reason: string };

function isErrnoWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isManagedArchiveFile(fileName: string): boolean {
  return fileName.startsWith(FILE_PREFIX) && fileName.endsWith(FILE_SUFFIX);
}

export function computeStoreLayoutFingerprint(
  data: StructuralStoreShape,
): string {
  const projects = [...(data.projects ?? [])]
    .map((project) => project.id)
    .sort((left, right) => left.localeCompare(right));
  const sessions = [...(data.sessions ?? [])]
    .map((session) => ({
      id: session.id,
      projectId: session.projectId ?? "",
      cwd: session.cwd ?? "",
      status: session.status ?? "",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const panels = [...(data.panels ?? [])]
    .map((panel) => ({
      id: panel.id,
      terminalSessionId: panel.terminalSessionId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return createHash("sha256")
    .update(JSON.stringify({ projects, sessions, panels }))
    .digest("hex");
}

function validateParsedStoreObject(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "root_not_object";
  }

  const record = parsed as Record<string, unknown>;
  if ("schemaVersion" in record && record.schemaVersion !== undefined) {
    const version = record.schemaVersion;
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 0 ||
      version > MAX_SUPPORTED_STORE_SCHEMA_VERSION
    ) {
      return `unsupported_schema_version:${String(version)}`;
    }
  }

  for (const key of ARRAY_COLLECTION_KEYS) {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      return `invalid_collection:${key}`;
    }
  }

  const nonVersionKeys = Object.keys(record).filter(
    (key) => key !== "schemaVersion",
  );
  if (
    nonVersionKeys.length > 0 &&
    record.projects === undefined &&
    record.sessions === undefined
  ) {
    return "missing_core_collections";
  }

  return null;
}

export class TerminalStoreRecoveryController {
  readonly backupDir: string;
  readonly snapshotDir: string;
  private protectUnloaded = false;
  private lastArchiveTimestamp = 0;
  private tmpSequence = 0;

  constructor(
    private readonly storeFile: string,
    private readonly options?: {
      snapshotIntervalMs?: number;
      maxBackups?: number;
      maxSnapshots?: number;
    },
  ) {
    const baseDir = path.dirname(storeFile);
    this.backupDir = path.join(baseDir, BACKUP_DIR_NAME);
    this.snapshotDir = path.join(baseDir, SNAPSHOT_DIR_NAME);
  }

  isProtectingUnloaded(): boolean {
    return this.protectUnloaded;
  }

  async readAndValidate<T>(): Promise<StoreLoadResult<T>> {
    let rawBytes: Buffer;
    try {
      rawBytes = await readFile(this.storeFile);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        this.protectUnloaded = false;
        return { status: "missing" };
      }
      this.protectUnloaded = true;
      storeLogger.warn("terminal.session-store.read-failed", {
        message:
          "Failed to read terminal session store; protecting existing file before next write",
        storeFile: this.storeFile,
        error,
      });
      return { status: "corrupted", reason: "read_error" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString("utf8"));
    } catch (error) {
      this.protectUnloaded = true;
      storeLogger.warn("terminal.session-store.parse-failed", {
        message:
          "Terminal session store JSON is invalid; protecting corrupted file before next write",
        storeFile: this.storeFile,
        byteLength: rawBytes.byteLength,
        error,
      });
      return { status: "corrupted", reason: "invalid_json" };
    }

    const validationError = validateParsedStoreObject(parsed);
    if (validationError) {
      this.protectUnloaded = true;
      storeLogger.warn("terminal.session-store.schema-rejected", {
        message:
          "Terminal session store structure or schemaVersion was rejected; protecting file before next write",
        storeFile: this.storeFile,
        reason: validationError,
      });
      return { status: "corrupted", reason: validationError };
    }

    this.protectUnloaded = false;
    return { status: "ok", data: parsed as T };
  }

  async writeAtomically<T extends StructuralStoreShape>(data: T): Promise<void> {
    if (this.protectUnloaded) {
      await this.backupProtectedStoreFile();
      this.protectUnloaded = false;
    } else if ((data.sessions?.length ?? 0) === 0) {
      await this.maybeSnapshotBeforeEmptyOverwrite();
    }

    await this.atomicWriteJsonFile(this.storeFile, data);

    if ((data.sessions?.length ?? 0) > 0) {
      await this.maybeCreateThrottledSnapshot(data);
    }
  }

  private nextArchiveFileName(): string {
    const now = Date.now();
    this.lastArchiveTimestamp = Math.max(now, this.lastArchiveTimestamp + 1);
    return `${FILE_PREFIX}${this.lastArchiveTimestamp}-${process.pid}${FILE_SUFFIX}`;
  }

  private async backupProtectedStoreFile(): Promise<void> {
    let rawBytes: Buffer;
    try {
      rawBytes = await readFile(this.storeFile);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        return;
      }
      storeLogger.error("terminal.session-store.backup.read-failed", {
        message:
          "Refusing to overwrite protected terminal session store because reading original bytes failed",
        storeFile: this.storeFile,
        error,
      });
      throw error;
    }

    const backupFile = path.join(this.backupDir, this.nextArchiveFileName());
    try {
      await mkdir(this.backupDir, { recursive: true });
      await this.atomicWriteRawFile(backupFile, rawBytes);
      await this.pruneArchiveDirectory(
        this.backupDir,
        this.options?.maxBackups ?? MAX_CORRUPT_STORE_BACKUPS,
      );
      storeLogger.warn("terminal.session-store.backup.created", {
        message: "Backed up unloaded terminal session store before overwrite",
        storeFile: this.storeFile,
        backupFile,
        byteLength: rawBytes.byteLength,
      });
    } catch (error) {
      storeLogger.error("terminal.session-store.backup.failed", {
        message:
          "Refusing to overwrite protected terminal session store because backup failed",
        storeFile: this.storeFile,
        backupDir: this.backupDir,
        error,
      });
      throw error;
    }
  }

  private async maybeSnapshotBeforeEmptyOverwrite(): Promise<void> {
    try {
      const existingRaw = await readFile(this.storeFile, "utf8");
      const parsed = JSON.parse(existingRaw) as StructuralStoreShape;
      if ((parsed.sessions?.length ?? 0) > 0) {
        await this.maybeCreateThrottledSnapshot(parsed);
      }
    } catch {
      // Ignore missing or unreadable prior store during fail-open snapshot check.
    }
  }

  private async maybeCreateThrottledSnapshot(
    currentData: StructuralStoreShape,
  ): Promise<void> {
    try {
      await mkdir(this.snapshotDir, { recursive: true });
      const entries = (await readdir(this.snapshotDir))
        .filter(isManagedArchiveFile)
        .sort((left, right) => left.localeCompare(right));

      const intervalMs =
        this.options?.snapshotIntervalMs ?? STORE_SNAPSHOT_INTERVAL_MS;
      const latestName = entries.at(-1);
      if (latestName) {
        const latestPath = path.join(this.snapshotDir, latestName);
        const latestStats = await stat(latestPath);
        if (Date.now() - latestStats.mtimeMs < intervalMs) {
          return;
        }
        try {
          const latestParsed = JSON.parse(
            await readFile(latestPath, "utf8"),
          ) as StructuralStoreShape;
          if (
            computeStoreLayoutFingerprint(latestParsed) ===
            computeStoreLayoutFingerprint(currentData)
          ) {
            return;
          }
        } catch {
          // If the latest snapshot cannot be parsed, proceed to write a fresh snapshot.
        }
      }

      const snapshotFile = path.join(
        this.snapshotDir,
        this.nextArchiveFileName(),
      );
      await copyFile(this.storeFile, snapshotFile);
      await this.pruneArchiveDirectory(
        this.snapshotDir,
        this.options?.maxSnapshots ?? MAX_STORE_SNAPSHOTS,
      );
    } catch (error) {
      storeLogger.warn("terminal.session-store.snapshot.failed", {
        message: "Failed to record periodic terminal session store snapshot",
        storeFile: this.storeFile,
        snapshotDir: this.snapshotDir,
        error,
      });
    }
  }

  private async pruneArchiveDirectory(
    directory: string,
    maxRetained: number,
  ): Promise<void> {
    const entries = (await readdir(directory))
      .filter(isManagedArchiveFile)
      .sort((left, right) => left.localeCompare(right));
    if (entries.length <= maxRetained) {
      return;
    }
    const staleEntries = entries.slice(0, entries.length - maxRetained);
    await Promise.all(
      staleEntries.map((entry) =>
        rm(path.join(directory, entry), { force: true }),
      ),
    );
  }

  private async atomicWriteJsonFile(
    targetFile: string,
    data: unknown,
  ): Promise<void> {
    const serialized = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await this.atomicWriteRawFile(targetFile, serialized);
  }

  private async atomicWriteRawFile(
    targetFile: string,
    bytes: Buffer,
  ): Promise<void> {
    await mkdir(path.dirname(targetFile), { recursive: true });
    this.tmpSequence += 1;
    const tempFile = `${targetFile}.tmp-${process.pid}-${this.tmpSequence}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempFile, "w", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempFile, targetFile);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
