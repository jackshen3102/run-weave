import { v4 as uuidv4 } from "uuid";
import { TERMINAL_PERSISTED_SCROLLBACK_BYTES } from "@browser-viewer/shared";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
} from "./store";

export interface TerminalProjectRecord {
  id: string;
  name: string;
  createdAt: Date;
  isDefault: boolean;
}

export interface TerminalSessionRecord {
  id: string;
  projectId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  exitCode?: number;
}

export interface CreateTerminalSessionOptions {
  projectId?: string;
  name?: string;
  command: string;
  args?: string[];
  cwd: string;
}

function buildProjectRecord(
  persisted: PersistedTerminalProjectRecord,
): TerminalProjectRecord {
  return {
    id: persisted.id,
    name: persisted.name,
    createdAt: new Date(persisted.createdAt),
    isDefault: persisted.isDefault,
  };
}

function toPersistedProject(
  project: TerminalProjectRecord,
): PersistedTerminalProjectRecord {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    isDefault: project.isDefault,
  };
}

function buildRecord(
  persisted: PersistedTerminalSessionRecord,
): TerminalSessionRecord {
  return {
    id: persisted.id,
    projectId: persisted.projectId,
    name: persisted.name,
    command: persisted.command,
    args: persisted.args,
    cwd: persisted.cwd,
    scrollback: persisted.scrollback,
    status: persisted.status,
    createdAt: new Date(persisted.createdAt),
    exitCode: persisted.exitCode,
  };
}

function toPersisted(
  session: TerminalSessionRecord,
): PersistedTerminalSessionRecord {
  return {
    id: session.id,
    projectId: session.projectId,
    name: session.name,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    scrollback: session.scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    exitCode: session.exitCode,
  };
}

const SCROLLBACK_FLUSH_DELAY_MS = 250;

export class TerminalSessionManager {
  private readonly projects = new Map<string, TerminalProjectRecord>();
  private readonly sessions = new Map<string, TerminalSessionRecord>();
  private readonly scrollbackFlushTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly sessionStore: TerminalSessionStore) {}

  async initialize(): Promise<void> {
    await this.sessionStore.initialize();
    const persistedProjects = await this.sessionStore.listProjects();
    const persistedSessions = await this.sessionStore.listSessions();

    for (const persisted of persistedProjects) {
      this.projects.set(persisted.id, buildProjectRecord(persisted));
    }
    for (const persisted of persistedSessions) {
      this.sessions.set(persisted.id, buildRecord(persisted));
    }
  }

  listProjects(): TerminalProjectRecord[] {
    return Array.from(this.projects.values()).sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
  }

  getProject(projectId: string): TerminalProjectRecord | undefined {
    return this.projects.get(projectId);
  }

  async createProject(name: string): Promise<TerminalProjectRecord> {
    const project: TerminalProjectRecord = {
      id: uuidv4(),
      name: name.trim(),
      createdAt: new Date(),
      isDefault: this.projects.size === 0,
    };

    await this.sessionStore.insertProject(toPersistedProject(project));
    this.projects.set(project.id, project);
    if (project.isDefault) {
      await this.sessionStore.setDefaultProject(project.id);
    }
    return project;
  }

  async updateProject(
    projectId: string,
    name: string,
  ): Promise<TerminalProjectRecord | undefined> {
    const project = this.projects.get(projectId);
    if (!project) {
      return undefined;
    }

    project.name = name.trim();
    await this.sessionStore.updateProject({
      projectId,
      name: project.name,
    });
    return project;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const project = this.projects.get(projectId);
    if (!project) {
      return false;
    }

    const childSessionIds = this.listSessions()
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id);
    for (const sessionId of childSessionIds) {
      await this.destroySession(sessionId);
    }

    this.projects.delete(projectId);
    await this.sessionStore.deleteProject(projectId);

    if (this.projects.size === 0) {
      await this.createProject("Default Project");
      return true;
    }

    if (project.isDefault) {
      const nextDefault = this.listProjects()[0];
      if (nextDefault) {
        for (const candidate of this.projects.values()) {
          candidate.isDefault = candidate.id === nextDefault.id;
        }
        await this.sessionStore.setDefaultProject(nextDefault.id);
      }
    }

    return true;
  }

  private getDefaultProjectId(): string {
    const currentDefault = this.listProjects().find((project) => project.isDefault);
    if (currentDefault) {
      return currentDefault.id;
    }

    const fallback = this.listProjects()[0];
    if (fallback) {
      fallback.isDefault = true;
      void this.sessionStore.setDefaultProject(fallback.id);
      return fallback.id;
    }

    throw new Error("[viewer-be] terminal default project not initialized");
  }

  async createSession(
    options: CreateTerminalSessionOptions,
  ): Promise<TerminalSessionRecord> {
    const now = new Date();
    const projectId = options.projectId ?? this.getDefaultProjectId();
    const session: TerminalSessionRecord = {
      id: uuidv4(),
      projectId,
      name: options.name?.trim() || options.command,
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      scrollback: "",
      status: "running",
      createdAt: now,
    };

    await this.sessionStore.insertSession(toPersisted(session));
    this.sessions.set(session.id, session);
    return session;
  }

  getScrollback(terminalSessionId: string): string {
    return this.sessions.get(terminalSessionId)?.scrollback ?? "";
  }

  appendOutput(terminalSessionId: string, chunk: string): void {
    if (!chunk) {
      return;
    }

    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    session.scrollback = `${session.scrollback}${chunk}`.slice(
      -TERMINAL_PERSISTED_SCROLLBACK_BYTES,
    );
    this.scheduleScrollbackFlush(terminalSessionId);
  }

  getSession(terminalSessionId: string): TerminalSessionRecord | undefined {
    return this.sessions.get(terminalSessionId);
  }

  listSessions(): TerminalSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  markExited(terminalSessionId: string, exitCode?: number): void {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    session.status = "exited";
    session.exitCode = exitCode;
    void this.sessionStore.updateSessionExit({
      terminalSessionId,
      status: "exited",
      exitCode,
    });
  }

  async updateSessionMetadata(
    terminalSessionId: string,
    metadata: {
      name: string;
      cwd: string;
    },
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    if (session.name === metadata.name && session.cwd === metadata.cwd) {
      return session;
    }

    session.name = metadata.name;
    session.cwd = metadata.cwd;
    await this.sessionStore.updateSessionMetadata({
      terminalSessionId,
      name: metadata.name,
      cwd: metadata.cwd,
    });
    return session;
  }

  async updateSessionName(
    terminalSessionId: string,
    name: string,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    return this.updateSessionMetadata(terminalSessionId, {
      name,
      cwd: session.cwd,
    });
  }

  async destroySession(terminalSessionId: string): Promise<boolean> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return false;
    }

    this.clearPendingScrollbackFlush(terminalSessionId);
    this.sessions.delete(terminalSessionId);
    await this.sessionStore.deleteSession(terminalSessionId);
    return true;
  }

  async dispose(): Promise<void> {
    await this.flushAllPendingScrollback();
    await this.sessionStore.dispose();
  }

  private scheduleScrollbackFlush(terminalSessionId: string): void {
    this.clearPendingScrollbackFlush(terminalSessionId);

    const timer = setTimeout(() => {
      this.scrollbackFlushTimers.delete(terminalSessionId);
      void this.flushScrollback(terminalSessionId);
    }, SCROLLBACK_FLUSH_DELAY_MS);
    this.scrollbackFlushTimers.set(terminalSessionId, timer);
  }

  private clearPendingScrollbackFlush(terminalSessionId: string): void {
    const timer = this.scrollbackFlushTimers.get(terminalSessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.scrollbackFlushTimers.delete(terminalSessionId);
  }

  private async flushScrollback(terminalSessionId: string): Promise<void> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    await this.sessionStore.updateSessionScrollback({
      terminalSessionId,
      scrollback: session.scrollback,
    });
  }

  private async flushAllPendingScrollback(): Promise<void> {
    const pendingSessionIds = Array.from(this.scrollbackFlushTimers.keys());
    pendingSessionIds.forEach((terminalSessionId) =>
      this.clearPendingScrollbackFlush(terminalSessionId),
    );
    await Promise.all(
      pendingSessionIds.map((terminalSessionId) =>
        this.flushScrollback(terminalSessionId),
      ),
    );
  }
}
