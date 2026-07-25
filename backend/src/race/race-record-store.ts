import { rm } from "node:fs/promises";
import type { RaceRecord } from "@runweave/shared/race";
import { readJsonFile, writeJsonFile } from "../agent-team/storage/json-file";

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRaceRecord(value: unknown): value is RaceRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<RaceRecord>;
  return (
    typeof record.raceId === "string" &&
    typeof record.goal === "string" &&
    typeof record.plan === "string" &&
    typeof record.baseRef === "string" &&
    typeof record.parentProjectId === "string" &&
    typeof record.createdAt === "string" &&
    Array.isArray(record.workers) &&
    record.workers.every(
      (worker) =>
        Boolean(worker) &&
        typeof worker.workerId === "string" &&
        typeof worker.label === "string" &&
        (worker.agent === "codex" || worker.agent === "traex") &&
        typeof worker.model === "string" &&
        isNullableString(worker.worktreeId) &&
        isNullableString(worker.worktreePath) &&
        isNullableString(worker.branch) &&
        isNullableString(worker.terminalSessionId) &&
        (worker.launchStatus === "starting" ||
          worker.launchStatus === "launched" ||
          worker.launchStatus === "failed")
    )
  );
}

export class RaceRecordStore {
  private current: RaceRecord | null = null;

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    const record = await readJsonFile<unknown>(this.filePath);
    this.current = isRaceRecord(record) ? record : null;
  }

  getCurrent(): RaceRecord | null {
    return this.current;
  }

  async write(record: RaceRecord): Promise<void> {
    await writeJsonFile(this.filePath, record);
    this.current = record;
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
    this.current = null;
  }
}
