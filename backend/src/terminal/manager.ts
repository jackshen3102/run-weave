import { v4 as uuidv4 } from "uuid";
import type {
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
} from "./store";

export interface TerminalSessionRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  linkedBrowserSessionId?: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  lastActivityAt: Date;
  exitCode?: number;
}

export interface CreateTerminalSessionOptions {
  name?: string;
  command: string;
  args?: string[];
  cwd: string;
  linkedBrowserSessionId?: string;
}

function buildRecord(
  persisted: PersistedTerminalSessionRecord,
): TerminalSessionRecord {
  return {
    id: persisted.id,
    name: persisted.name,
    command: persisted.command,
    args: persisted.args,
    cwd: persisted.cwd,
    linkedBrowserSessionId: persisted.linkedBrowserSessionId,
    scrollback: persisted.scrollback,
    status: persisted.status,
    createdAt: new Date(persisted.createdAt),
    lastActivityAt: new Date(persisted.lastActivityAt),
    exitCode: persisted.exitCode,
  };
}

function toPersisted(
  session: TerminalSessionRecord,
): PersistedTerminalSessionRecord {
  return {
    id: session.id,
    name: session.name,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    linkedBrowserSessionId: session.linkedBrowserSessionId,
    scrollback: session.scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
  };
}

const MAX_SCROLLBACK_LENGTH = 256 * 1024;

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSessionRecord>();

  constructor(private readonly sessionStore: TerminalSessionStore) {}

  async initialize(): Promise<void> {
    await this.sessionStore.initialize();
    const persistedSessions = await this.sessionStore.listSessions();

    for (const persisted of persistedSessions) {
      this.sessions.set(persisted.id, buildRecord(persisted));
    }
  }

  async createSession(
    options: CreateTerminalSessionOptions,
  ): Promise<TerminalSessionRecord> {
    const now = new Date();
    const session: TerminalSessionRecord = {
      id: uuidv4(),
      name: options.name?.trim() || options.command,
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      linkedBrowserSessionId: options.linkedBrowserSessionId,
      scrollback: "",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
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
      -MAX_SCROLLBACK_LENGTH,
    );
    void this.sessionStore.appendSessionScrollback({
      terminalSessionId,
      chunk,
      maxLength: MAX_SCROLLBACK_LENGTH,
    });
  }

  getSession(terminalSessionId: string): TerminalSessionRecord | undefined {
    return this.sessions.get(terminalSessionId);
  }

  listSessions(): TerminalSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  markActivity(terminalSessionId: string): void {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    session.lastActivityAt = new Date();
    void this.sessionStore.updateSessionActivity({
      terminalSessionId,
      lastActivityAt: session.lastActivityAt.toISOString(),
    });
  }

  markExited(terminalSessionId: string, exitCode?: number): void {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    session.status = "exited";
    session.exitCode = exitCode;
    session.lastActivityAt = new Date();
    void this.sessionStore.updateSessionExit({
      terminalSessionId,
      status: "exited",
      exitCode,
      lastActivityAt: session.lastActivityAt.toISOString(),
    });
  }

  async updateSessionName(
    terminalSessionId: string,
    name: string,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    session.name = name;
    await this.sessionStore.updateSessionName(terminalSessionId, name);
    return session;
  }

  async destroySession(terminalSessionId: string): Promise<boolean> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return false;
    }

    this.sessions.delete(terminalSessionId);
    await this.sessionStore.deleteSession(terminalSessionId);
    return true;
  }

  async dispose(): Promise<void> {
    await this.sessionStore.dispose();
  }
}
