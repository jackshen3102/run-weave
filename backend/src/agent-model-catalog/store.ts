import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentCatalogModel,
  AgentModelProvider,
} from "@runweave/shared/agent-model-catalog";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

export interface PersistedAgentProviderCatalog {
  schemaVersion: 1;
  provider: AgentModelProvider;
  command: AgentModelProvider;
  version: string | null;
  capturedAt: string;
  models: AgentCatalogModel[];
}

interface AgentModelStoreData {
  catalogs: Partial<Record<AgentModelProvider, PersistedAgentProviderCatalog>>;
}

const DEFAULT_DATA: AgentModelStoreData = {
  catalogs: {},
};

export class AgentModelCatalogStore {
  private database: Low<AgentModelStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storeFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });
    const database = new Low(
      new JSONFile<AgentModelStoreData>(this.storeFile),
      structuredClone(DEFAULT_DATA),
    );
    await database.read();
    const raw = database.data as unknown;
    database.data = {
      catalogs: {
        ...(isRecord(raw) &&
        isRecord(raw.catalogs) &&
        isPersistedCatalog(raw.catalogs.codex, "codex")
          ? { codex: structuredClone(raw.catalogs.codex) }
          : {}),
        ...(isRecord(raw) &&
        isRecord(raw.catalogs) &&
        isPersistedCatalog(raw.catalogs.traex, "traex")
          ? { traex: structuredClone(raw.catalogs.traex) }
          : {}),
      },
    };
    this.database = database;
  }

  getCatalog(
    provider: AgentModelProvider,
  ): PersistedAgentProviderCatalog | null {
    const catalog = this.getDatabase().data.catalogs[provider];
    return catalog ? structuredClone(catalog) : null;
  }

  async saveCatalog(catalog: PersistedAgentProviderCatalog): Promise<void> {
    await this.enqueueWrite(async () => {
      this.getDatabase().data.catalogs[catalog.provider] =
        structuredClone(catalog);
      await this.getDatabase().write();
    });
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    this.database = null;
  }

  private getDatabase(): Low<AgentModelStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] agent model catalog store not initialized");
    }
    return this.database;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function isPersistedCatalog(
  value: unknown,
  provider: AgentModelProvider,
): value is PersistedAgentProviderCatalog {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.provider === provider &&
    value.command === provider &&
    (value.version === null || typeof value.version === "string") &&
    typeof value.capturedAt === "string" &&
    Number.isFinite(Date.parse(value.capturedAt)) &&
    Array.isArray(value.models) &&
    value.models.every(isCatalogModel)
  );
}

function isCatalogModel(value: unknown): value is AgentCatalogModel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.label === "string" &&
    typeof value.description === "string" &&
    (value.contextWindow === null ||
      (typeof value.contextWindow === "number" &&
        Number.isFinite(value.contextWindow))) &&
    (value.defaultReasoningEffort === null ||
      typeof value.defaultReasoningEffort === "string") &&
    Array.isArray(value.reasoningEfforts) &&
    value.reasoningEfforts.every((effort) => typeof effort === "string") &&
    typeof value.supportsFast === "boolean" &&
    typeof value.supportsMax === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
