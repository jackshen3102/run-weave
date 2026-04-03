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
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  exitCode?: number;
}

export interface CreateTerminalSessionOptions {
  name?: string;
  command: string;
  args?: string[];
  cwd: string;
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

const MAX_SCROLLBACK_LENGTH = 256 * 1024;
const SCROLLBACK_FLUSH_DELAY_MS = 250;

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSessionRecord>();
  private readonly scrollbackFlushTimers = new Map<string, NodeJS.Timeout>();

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
      -MAX_SCROLLBACK_LENGTH,
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
