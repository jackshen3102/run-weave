import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalProjectParams,
  UpdateTerminalSessionExitParams,
  UpdateTerminalSessionMetadataParams,
  UpdateTerminalSessionScrollbackParams,
} from "./store";

interface TerminalSessionStoreData {
  projects: PersistedTerminalProjectRecord[];
  sessions: PersistedTerminalSessionRecord[];
}

interface LegacyTerminalSessionStoreData {
  projects?: PersistedTerminalProjectRecord[];
  sessions?: Array<PersistedTerminalSessionRecord | Omit<PersistedTerminalSessionRecord, "projectId">>;
}

const DEFAULT_DATA: TerminalSessionStoreData = {
  projects: [],
  sessions: [],
};

export class LowDbTerminalSessionStore implements TerminalSessionStore {
  private database: Low<TerminalSessionStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storeFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });

    const database = new Low(
      new JSONFile<LegacyTerminalSessionStoreData>(this.storeFile),
      { ...DEFAULT_DATA },
    );
    await database.read();
    const rawData = database.data ?? { ...DEFAULT_DATA };
    const projects = [...(rawData.projects ?? [])];
    const sessions = [...(rawData.sessions ?? [])];

    if (projects.length === 0) {
      projects.push({
        id: crypto.randomUUID(),
        name: "Default Project",
        createdAt: new Date().toISOString(),
        isDefault: true,
      });
    }

    const defaultProjectId =
      projects.find((project) => project.isDefault)?.id ?? projects[0]?.id;
    const normalizedSessions = sessions.map((session) => ({
      ...session,
      projectId: "projectId" in session ? session.projectId : (defaultProjectId ?? ""),
    }));

    database.data = {
      projects,
      sessions: normalizedSessions,
    };
    await database.write();
    this.database = database as unknown as Low<TerminalSessionStoreData>;
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    this.database = null;
  }

  async listSessions(): Promise<PersistedTerminalSessionRecord[]> {
    return this.getSessions();
  }

  async listProjects(): Promise<PersistedTerminalProjectRecord[]> {
    return this.getProjects();
  }

  async getProject(
    projectId: string,
  ): Promise<PersistedTerminalProjectRecord | null> {
    return this.getProjects().find((project) => project.id === projectId) ?? null;
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

  async insertProject(project: PersistedTerminalProjectRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.projects.push(structuredClone(project));
      await database.write();
    });
  }

  async updateProject(params: UpdateTerminalProjectParams): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const project = database.data.projects.find(
        (candidate) => candidate.id === params.projectId,
      );
      if (!project) {
        return;
      }

      project.name = params.name;
      await database.write();
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.projects = database.data.projects.filter(
        (project) => project.id !== projectId,
      );
      database.data.sessions = database.data.sessions.filter(
        (session) => session.projectId !== projectId,
      );
      await database.write();
    });
  }

  async setDefaultProject(projectId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      for (const project of database.data.projects) {
        project.isDefault = project.id === projectId;
      }
      await database.write();
    });
  }

  async updateSessionMetadata(
    params: UpdateTerminalSessionMetadataParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.name = params.name;
      session.cwd = params.cwd;
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

  private getProjects(): PersistedTerminalProjectRecord[] {
    return this.getDatabase()
      .data.projects
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((project) => structuredClone(project));
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run;
    return run;
  }
}
