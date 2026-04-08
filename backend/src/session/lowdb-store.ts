import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  PersistedSessionRecord,
  SessionStore,
  UpdateSessionConnectionParams,
} from "./store";

interface SessionStoreData {
  sessions: PersistedSessionRecord[];
}

const DEFAULT_DATA: SessionStoreData = {
  sessions: [],
};

export class LowDbSessionStore implements SessionStore {
  private database: Low<SessionStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storeFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });

    const database = new Low(new JSONFile<SessionStoreData>(this.storeFile), {
      ...DEFAULT_DATA,
    });
    await database.read();
    database.data ||= { sessions: [] };
    await database.write();
    this.database = database;
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    this.database = null;
  }

  async listSessions(): Promise<PersistedSessionRecord[]> {
    return this.getSessions();
  }

  async getSession(sessionId: string): Promise<PersistedSessionRecord | null> {
    return this.getSessions().find((session) => session.id === sessionId) ?? null;
  }

  async insertSession(session: PersistedSessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.sessions.push(structuredClone(session));
      await database.write();
    });
  }

  async updateSessionName(sessionId: string, name: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (!session) {
        return;
      }

      session.name = name;
      await database.write();
    });
  }

  async updateSessionConnection(
    params: UpdateSessionConnectionParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.sessionId,
      );
      if (!session) {
        return;
      }

      session.connected = params.connected;
      session.lastActivityAt = params.lastActivityAt;
      await database.write();
    });
  }

  async setPreferredForAiSession(sessionId: string | null): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      for (const session of database.data.sessions) {
        session.preferredForAi =
          sessionId !== null && session.id === sessionId;
      }
      await database.write();
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.sessions = database.data.sessions.filter(
        (session) => session.id !== sessionId,
      );
      await database.write();
    });
  }

  private getDatabase(): Low<SessionStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] session store not initialized");
    }

    return this.database;
  }

  private getSessions(): PersistedSessionRecord[] {
    return this.getDatabase()
      .data.sessions
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((session) => ({
        ...structuredClone(session),
        preferredForAi: session.preferredForAi ?? false,
      }));
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run;
    return run;
  }
}
