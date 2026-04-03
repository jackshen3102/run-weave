import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalSessionExitParams,
  UpdateTerminalSessionScrollbackParams,
} from "./store";

interface TerminalSessionStoreData {
  sessions: PersistedTerminalSessionRecord[];
}

const DEFAULT_DATA: TerminalSessionStoreData = {
  sessions: [],
};

export class LowDbTerminalSessionStore implements TerminalSessionStore {
  private database: Low<TerminalSessionStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storeFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });

    const database = new Low(
      new JSONFile<TerminalSessionStoreData>(this.storeFile),
      { ...DEFAULT_DATA },
    );
    await database.read();
    database.data ||= { sessions: [] };
    await database.write();
    this.database = database;
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    this.database = null;
  }

  async listSessions(): Promise<PersistedTerminalSessionRecord[]> {
    return this.getSessions();
  }

  async getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null> {
    return (
      this.getSessions().find((session) => session.id === terminalSessionId) ??
      null
    );
  }

  async insertSession(session: PersistedTerminalSessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.sessions.push(structuredClone(session));
      await database.write();
    });
  }

  async updateSessionName(
    terminalSessionId: string,
    name: string,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.name = name;
      await database.write();
    });
  }

  async updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.scrollback = params.scrollback;
      await database.write();
    });
  }

  async updateSessionExit(
    params: UpdateTerminalSessionExitParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.status = params.status;
      session.exitCode = params.exitCode;
      await database.write();
    });
  }

  async deleteSession(terminalSessionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.sessions = database.data.sessions.filter(
        (session) => session.id !== terminalSessionId,
      );
      await database.write();
    });
  }

  private getDatabase(): Low<TerminalSessionStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] terminal session store not initialized");
    }

    return this.database;
  }

  private getSessions(): PersistedTerminalSessionRecord[] {
    return this.getDatabase()
      .data.sessions
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((session) => structuredClone(session));
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run;
    return run;
  }
}
