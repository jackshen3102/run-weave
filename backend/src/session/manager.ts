import { v4 as uuidv4 } from "uuid";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserService, type BrowserSession } from "../browser/service";

export interface SessionRecord {
  id: string;
  targetUrl: string;
  createdAt: Date;
  lastActivityAt: Date;
  connected: boolean;
  browserSession: BrowserSession;
}

interface SessionManagerOptions {
  persistencePath?: string;
}

interface PersistedSessionRecord {
  id: string;
  targetUrl: string;
  createdAt: string;
  lastActivityAt: string;
}


export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly persistencePath: string | null;

  constructor(
    private readonly browserService: BrowserService,
    options?: SessionManagerOptions,
  ) {
    this.persistencePath = options?.persistencePath?.trim() || null;
  }

  async initialize(): Promise<void> {
    await this.restorePersistedSessions();
  }

  async createSession(targetUrl: string): Promise<SessionRecord> {
    const sessionId = uuidv4();
    const browserSession = await this.browserService.createSession(
      sessionId,
      targetUrl,
    );
    const session: SessionRecord = {
      id: sessionId,
      targetUrl,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      connected: false,
      browserSession,
    };
    this.sessions.set(session.id, session);
    void this.persistSessions();
    return session;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  markConnected(sessionId: string, connected: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.lastActivityAt = new Date();
    session.connected = connected;
    if (connected) {
      this.cancelPendingDestroy(sessionId);
    }
    void this.persistSessions();
  }

  async destroySession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.cancelPendingDestroy(sessionId);
    this.sessions.delete(sessionId);
    await this.browserService.destroySession(sessionId, session.browserSession);
    await this.persistSessions();
    return true;
  }

  listSessions(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  getRemoteDebuggingPort(): number | null {
    return this.browserService.getRemoteDebuggingPort();
  }

  isDevtoolsEnabled(): boolean {
    return this.browserService.isDevtoolsEnabled();
  }

  async dispose(): Promise<void> {
    this.disconnectTimers.forEach((timer) => clearTimeout(timer));
    this.disconnectTimers.clear();
    await this.browserService.stop();
  }

  private async restorePersistedSessions(): Promise<void> {
    if (!this.persistencePath) {
      return;
    }

    const records = await this.readPersistedSessions();
    if (records.length === 0) {
      return;
    }

    for (const record of records) {
      try {
        const browserSession = await this.browserService.createSession(
          record.id,
          record.targetUrl,
        );
        this.sessions.set(record.id, {
          id: record.id,
          targetUrl: record.targetUrl,
          createdAt: new Date(record.createdAt),
          lastActivityAt: new Date(record.lastActivityAt),
          connected: false,
          browserSession,
        });
      } catch (error) {
        console.error("[viewer-be] failed to restore session", {
          sessionId: record.id,
          error: String(error),
        });
      }
    }

    await this.persistSessions();
  }

  private async readPersistedSessions(): Promise<PersistedSessionRecord[]> {
    if (!this.persistencePath) {
      return [];
    }

    try {
      const raw = await readFile(this.persistencePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter((item): item is PersistedSessionRecord => {
        if (!item || typeof item !== "object") {
          return false;
        }

        const record = item as Partial<PersistedSessionRecord>;
        return (
          typeof record.id === "string" &&
          typeof record.targetUrl === "string" &&
          typeof record.createdAt === "string" &&
          typeof record.lastActivityAt === "string"
        );
      });
    } catch {
      return [];
    }
  }

  private async persistSessions(): Promise<void> {
    if (!this.persistencePath) {
      return;
    }

    const payload: PersistedSessionRecord[] = Array.from(
      this.sessions.values(),
    ).map((session) => ({
      id: session.id,
      targetUrl: session.targetUrl,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
    }));

    try {
      await mkdir(path.dirname(this.persistencePath), { recursive: true });
      await writeFile(
        this.persistencePath,
        JSON.stringify(payload, null, 2),
        "utf-8",
      );
    } catch (error) {
      console.error("[viewer-be] failed to persist sessions", {
        error: String(error),
      });
    }
  }

  private cancelPendingDestroy(sessionId: string): void {
    const timer = this.disconnectTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.disconnectTimers.delete(sessionId);
  }
}
