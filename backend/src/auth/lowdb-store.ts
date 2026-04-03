import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type { AuthStore, PersistedAuthRecord } from "./store";

interface AuthStoreData {
  auth: PersistedAuthRecord | null;
}

const DEFAULT_DATA: AuthStoreData = {
  auth: null,
};

export class LowDbAuthStore implements AuthStore {
  private database: Low<AuthStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storeFile: string) {}

  async initialize(
    defaultRecord: PersistedAuthRecord,
  ): Promise<PersistedAuthRecord> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });

    const database = new Low(new JSONFile<AuthStoreData>(this.storeFile), {
      ...DEFAULT_DATA,
    });
    await database.read();
    database.data ||= { auth: null };
    if (!database.data.auth) {
      database.data.auth = structuredClone(defaultRecord);
      await database.write();
    }
    this.database = database;
    return structuredClone(database.data.auth);
  }

  async updatePassword(params: {
    password: string;
    jwtSecret: string;
    updatedAt: string;
  }): Promise<PersistedAuthRecord> {
    return await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const auth = database.data.auth;
      if (!auth) {
        throw new Error("[viewer-be] auth store not initialized");
      }

      auth.password = params.password;
      auth.jwtSecret = params.jwtSecret;
      auth.updatedAt = params.updatedAt;
      await database.write();
      return structuredClone(auth);
    });
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    this.database = null;
  }

  private getDatabase(): Low<AuthStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] auth store not initialized");
    }

    return this.database;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run.then(() => undefined, () => undefined);
    return run;
  }
}
