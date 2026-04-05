import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  AuthStore,
  PersistedAuthRecord,
  PersistedRefreshSessionRecord,
} from "./store";

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
    database.data.auth.refreshSessions ||= [];
    this.database = database;
    return structuredClone(database.data.auth);
  }

  async updatePassword(params: {
    password: string;
    jwtSecret: string;
    updatedAt: string;
  }): Promise<PersistedAuthRecord> {
    return await this.enqueueWrite(async () => {
      const auth = this.getAuthRecord();
      auth.password = params.password;
      auth.jwtSecret = params.jwtSecret;
      auth.updatedAt = params.updatedAt;
      await this.getDatabase().write();
      return structuredClone(auth);
    });
  }

  async createRefreshSession(
    session: PersistedRefreshSessionRecord,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const auth = this.getAuthRecord();
      auth.refreshSessions.push(structuredClone(session));
      await this.getDatabase().write();
    });
  }

  async getRefreshSession(
    sessionId: string,
  ): Promise<PersistedRefreshSessionRecord | null> {
    const auth = this.getAuthRecord();
    const session = auth.refreshSessions.find((entry) => entry.id === sessionId);
    return session ? structuredClone(session) : null;
  }

  async replaceRefreshSession(
    sessionId: string,
    nextSession: PersistedRefreshSessionRecord,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const auth = this.getAuthRecord();
      const sessionIndex = auth.refreshSessions.findIndex(
        (entry) => entry.id === sessionId,
      );
      if (sessionIndex < 0) {
        throw new Error("[viewer-be] refresh session not found");
      }
      auth.refreshSessions[sessionIndex] = {
        ...auth.refreshSessions[sessionIndex]!,
        revokedAt: nextSession.createdAt,
        replacedBySessionId: nextSession.id,
      };
      auth.refreshSessions.push(structuredClone(nextSession));
      await this.getDatabase().write();
    });
  }

  async revokeRefreshSession(
    sessionId: string,
    revokedAt: string,
  ): Promise<PersistedRefreshSessionRecord | null> {
    return await this.enqueueWrite(async () => {
      const auth = this.getAuthRecord();
      const session = auth.refreshSessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return null;
      }
      session.revokedAt = revokedAt;
      await this.getDatabase().write();
      return structuredClone(session);
    });
  }

  async revokeRefreshSessions(
    sessionIds: string[],
    revokedAt: string,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const auth = this.getAuthRecord();
      const sessionIdSet = new Set(sessionIds);
      for (const session of auth.refreshSessions) {
        if (!sessionIdSet.has(session.id)) {
          continue;
        }
        session.revokedAt = revokedAt;
      }
      await this.getDatabase().write();
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

  private getAuthRecord(): PersistedAuthRecord {
    const auth = this.getDatabase().data.auth;
    if (!auth) {
      throw new Error("[viewer-be] auth store not initialized");
    }
    auth.refreshSessions ||= [];
    return auth;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run.then(() => undefined, () => undefined);
    return run;
  }
}
