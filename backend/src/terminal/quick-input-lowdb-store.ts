import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  PersistedTerminalQuickInputRecord,
  TerminalQuickInputStore,
} from "./quick-input-store";

interface TerminalQuickInputStoreData {
  items: PersistedTerminalQuickInputRecord[];
}

const DEFAULT_DATA: TerminalQuickInputStoreData = {
  items: [],
};

export class LowDbTerminalQuickInputStore implements TerminalQuickInputStore {
  private database: Low<TerminalQuickInputStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storeFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });
    const database = new Low(
      new JSONFile<TerminalQuickInputStoreData>(this.storeFile),
      { ...DEFAULT_DATA },
    );
    await database.read();
    database.data = {
      items: [...(database.data?.items ?? [])],
    };
    await database.write();
    this.database = database;
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    this.database = null;
  }

  async list(): Promise<PersistedTerminalQuickInputRecord[]> {
    return this.getDatabase().data.items.map((item) => ({ ...item }));
  }

  async replaceAll(items: PersistedTerminalQuickInputRecord[]): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.items = items.map((item) => ({ ...item }));
      await database.write();
    });
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.pendingWrite.then(operation, operation);
    this.pendingWrite = next.catch(() => undefined);
    await next;
  }

  private getDatabase(): Low<TerminalQuickInputStoreData> {
    if (!this.database) {
      throw new Error("Terminal quick input store is not initialized");
    }
    return this.database;
  }
}
