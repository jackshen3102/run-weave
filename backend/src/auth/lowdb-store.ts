import { mkdir } from "node:fs/promises";
import { configuration, ConfigurationError } from "@runweave/config-node";
import { readConfigurationPath } from "@runweave/shared/configuration";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  AuthStore,
  PersistedAuthRecord,
  PersistedRefreshSessionRecord,
} from "./store";

interface AuthStoreData {
  auth: { refreshSessions: PersistedRefreshSessionRecord[] } | null;
}

const DEFAULT_DATA: AuthStoreData = {
  auth: null,
};

export class LowDbAuthStore implements AuthStore {
  private database: Low<AuthStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private credentials: Omit<PersistedAuthRecord, "refreshSessions"> | null = null;

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
    const legacy = database.data.auth as Partial<PersistedAuthRecord> | null;
    if (legacy && ["username", "password", "jwtSecret"].some((key) => {
      const name = key as "username" | "password" | "jwtSecret";
      return legacy[name] !== undefined && legacy[name] !== defaultRecord[name];
    })) throw new ConfigurationError("CONFIG_AUTH_MIGRATION_CONFLICT", ["backend.auth"]);
    const credentials = { username: defaultRecord.username, password: defaultRecord.password, jwtSecret: defaultRecord.jwtSecret, updatedAt: defaultRecord.updatedAt };
    this.credentials = credentials;
    database.data.auth = { refreshSessions: legacy?.refreshSessions ?? defaultRecord.refreshSessions };
    this.database = database;
    // The database owns sessions only; credentials are authoritative in YAML.
    await database.write();
    return { ...credentials, refreshSessions: structuredClone(database.data.auth.refreshSessions) };
  }

  async updatePassword(params: {
    password: string;
    jwtSecret: string;
    updatedAt: string;
  }): Promise<PersistedAuthRecord> {
    return await this.enqueueWrite(async () => {
      if (!this.credentials) throw new ConfigurationError("CONFIG_AUTH_NOT_INITIALIZED");
      const runtime = configuration();
      const current = runtime.store.read();
      for (const key of ["username", "password", "jwtSecret"] as const) {
        if (readConfigurationPath(current.value, `backend.auth.${key}`) !== this.credentials[key]) throw new ConfigurationError("CONFIG_REVISION_CONFLICT", ["backend.auth"]);
      }
      const saved = runtime.store.patch({ expectedRevision: current.value.revision, expectedDigest: current.digest, changes: { "backend.auth.password": params.password, "backend.auth.jwtSecret": params.jwtSecret } });
      this.credentials = { ...this.credentials, ...params };
      runtime.markSnapshotApplied(saved, "backend.auth");
      return { ...this.credentials, refreshSessions: structuredClone(this.getAuthRecord().refreshSessions) };
    });
  }

  async createRefreshSession(
    session: PersistedRefreshSessionRecord,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const auth = this.getAuthRecord();
      auth.refreshSessions.push(structuredClone(session));
      try {
        await this.getDatabase().write();
      } catch (error) {
        // Writes are serialized; remove only this uncommitted creation.
        auth.refreshSessions = auth.refreshSessions.filter((entry) => entry.id !== session.id);
        throw error;
      }
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
      if (nextSession.id === sessionId) {
        auth.refreshSessions[sessionIndex] = structuredClone(nextSession);
        await this.getDatabase().write();
        return;
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

  private getAuthRecord(): { refreshSessions: PersistedRefreshSessionRecord[] } {
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
