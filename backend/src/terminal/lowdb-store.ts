import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { TERMINAL_PERSISTED_SCROLLBACK_BYTES } from "@browser-viewer/shared";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  AppendTerminalSessionScrollbackParams,
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalProjectParams,
  UpdateTerminalSessionExitParams,
  UpdateTerminalSessionLaunchParams,
  UpdateTerminalSessionMetadataParams,
  UpdateTerminalSessionScrollbackParams,
} from "./store";
import {
  createScrollbackBuffer,
  readScrollbackBuffer,
} from "./scrollback-buffer";

interface TerminalSessionStoreData {
  projects: PersistedTerminalProjectRecord[];
  sessions: PersistedTerminalSessionMetadataRecord[];
}

type PersistedTerminalSessionMetadataRecord = Omit<
  PersistedTerminalSessionRecord,
  "scrollback"
>;

interface LegacyTerminalSessionStoreData {
  projects?: PersistedTerminalProjectRecord[];
  sessions?: Array<
    | PersistedTerminalSessionRecord
    | PersistedTerminalSessionMetadataRecord
    | Omit<PersistedTerminalSessionRecord, "projectId">
  >;
}

const DEFAULT_DATA: TerminalSessionStoreData = {
  projects: [],
  sessions: [],
};

export class LowDbTerminalSessionStore implements TerminalSessionStore {
  private database: Low<TerminalSessionStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingScrollbackWrite: Promise<void> = Promise.resolve();
  private readonly scrollbackDir: string;

  constructor(private readonly storeFile: string) {
    this.scrollbackDir = path.join(
      path.dirname(storeFile),
      "terminal-scrollback",
    );
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });
    await mkdir(this.scrollbackDir, { recursive: true });

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
    const normalizedSessions: PersistedTerminalSessionMetadataRecord[] = [];
    for (const session of sessions) {
      const { scrollback, ...metadata } =
        session as PersistedTerminalSessionRecord;
      if (scrollback) {
        await this.writeScrollbackFile(session.id, scrollback);
      }
      normalizedSessions.push({
        ...metadata,
        projectId:
          "projectId" in session ? session.projectId : (defaultProjectId ?? ""),
      });
    }

    database.data = {
      projects,
      sessions: normalizedSessions,
    };
    await database.write();
    this.database = database as unknown as Low<TerminalSessionStoreData>;
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    await this.pendingScrollbackWrite;
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
    return (
      this.getProjects().find((project) => project.id === projectId) ?? null
    );
  }

  async getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null> {
    return (
      (await this.getSessions()).find(
        (session) => session.id === terminalSessionId,
      ) ?? null
    );
  }

  async insertSession(session: PersistedTerminalSessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      if (session.scrollback) {
        await this.writeScrollbackFile(session.id, session.scrollback);
      }
      database.data.sessions.push(toMetadataRecord(session));
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
      const childSessionIds = database.data.sessions
        .filter((session) => session.projectId === projectId)
        .map((session) => session.id);
      database.data.projects = database.data.projects.filter(
        (project) => project.id !== projectId,
      );
      database.data.sessions = database.data.sessions.filter(
        (session) => session.projectId !== projectId,
      );
      await Promise.all(
        childSessionIds.map((terminalSessionId) =>
          this.deleteScrollbackFile(terminalSessionId),
        ),
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

  async updateSessionLaunch(
    params: UpdateTerminalSessionLaunchParams,
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
      session.command = params.command;
      session.args = [...params.args];
      await database.write();
    });
  }

  async updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void> {
    await this.enqueueScrollbackWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      await this.writeScrollbackFile(
        params.terminalSessionId,
        params.scrollback,
      );
    });
  }

  async appendSessionScrollback(
    params: AppendTerminalSessionScrollbackParams,
  ): Promise<void> {
    if (!params.chunk) {
      return;
    }

    await this.enqueueScrollbackWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      await this.appendScrollbackFile(params.terminalSessionId, params.chunk);
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
      await this.deleteScrollbackFile(terminalSessionId);
      await database.write();
    });
  }

  private getDatabase(): Low<TerminalSessionStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] terminal session store not initialized");
    }

    return this.database;
  }

  private async getSessions(): Promise<PersistedTerminalSessionRecord[]> {
    const sessions = this.getDatabase()
      .data.sessions.slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((session) => structuredClone(session));
    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        scrollback: await this.readScrollbackFile(session.id),
      })),
    );
  }

  private getProjects(): PersistedTerminalProjectRecord[] {
    return this.getDatabase()
      .data.projects.slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((project) => structuredClone(project));
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run;
    return run;
  }

  private enqueueScrollbackWrite(
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.pendingScrollbackWrite
      .catch(() => undefined)
      .then(operation);
    this.pendingScrollbackWrite = run;
    return run;
  }

  private resolveScrollbackFile(terminalSessionId: string): string {
    return path.join(
      this.scrollbackDir,
      `${encodeURIComponent(terminalSessionId)}.log`,
    );
  }

  private async readScrollbackFile(terminalSessionId: string): Promise<string> {
    try {
      return await readFile(
        this.resolveScrollbackFile(terminalSessionId),
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  private async writeScrollbackFile(
    terminalSessionId: string,
    scrollback: string,
  ): Promise<void> {
    await mkdir(this.scrollbackDir, { recursive: true });
    await writeFile(
      this.resolveScrollbackFile(terminalSessionId),
      scrollback,
      "utf8",
    );
  }

  private async appendScrollbackFile(
    terminalSessionId: string,
    chunk: string,
  ): Promise<void> {
    await mkdir(this.scrollbackDir, { recursive: true });
    const scrollbackFile = this.resolveScrollbackFile(terminalSessionId);
    await appendFile(scrollbackFile, chunk, "utf8");

    const stats = await stat(scrollbackFile);
    if (stats.size <= TERMINAL_PERSISTED_SCROLLBACK_BYTES) {
      return;
    }

    const oversizedScrollback = await readFile(scrollbackFile, "utf8");
    const compactedScrollback = readScrollbackBuffer(
      createScrollbackBuffer(
        oversizedScrollback,
        TERMINAL_PERSISTED_SCROLLBACK_BYTES,
      ),
    );
    await writeFile(scrollbackFile, compactedScrollback, "utf8");
  }

  private async deleteScrollbackFile(terminalSessionId: string): Promise<void> {
    await rm(this.resolveScrollbackFile(terminalSessionId), { force: true });
  }
}

function toMetadataRecord(
  session: PersistedTerminalSessionRecord,
): PersistedTerminalSessionMetadataRecord {
  return {
    id: session.id,
    projectId: session.projectId,
    name: session.name,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    status: session.status,
    createdAt: session.createdAt,
    exitCode: session.exitCode,
  };
}
