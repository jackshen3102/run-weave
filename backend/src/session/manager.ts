import { v4 as uuidv4 } from "uuid";
import { rm } from "node:fs/promises";
import { BrowserService, type BrowserSession } from "../browser/service";
import type { SessionStore } from "./store";

export interface SessionRecord {
  id: string;
  targetUrl: string;
  createdAt: Date;
  lastActivityAt: Date;
  connected: boolean;
  browserSession: BrowserSession;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly browserService: BrowserService,
    private readonly sessionStore: SessionStore,
  ) {}

  async initialize(): Promise<void> {
    await this.sessionStore.initialize();
    await this.restorePersistedSessions();
  }

  async createSession(targetUrl: string): Promise<SessionRecord> {
    const sessionId = uuidv4();
    const createdAt = new Date();
    const lastActivityAt = new Date();
    const profilePath = this.browserService.getSessionProfileDir(sessionId);
    const browserSession = await this.browserService.createSession(
      sessionId,
      targetUrl,
    );

    try {
      await this.sessionStore.insertSession({
        id: sessionId,
        targetUrl,
        connected: false,
        profilePath,
        createdAt: createdAt.toISOString(),
        lastActivityAt: lastActivityAt.toISOString(),
      });
    } catch (error) {
      await this.browserService.destroySession(sessionId, browserSession);
      throw error;
    }

    const session: SessionRecord = {
      id: sessionId,
      targetUrl,
      createdAt,
      lastActivityAt,
      connected: false,
      browserSession,
    };
    this.sessions.set(session.id, session);
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
    void this.sessionStore.updateSessionConnection({
      sessionId,
      connected,
      lastActivityAt: session.lastActivityAt.toISOString(),
    });
  }

  async destroySession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.cancelPendingDestroy(sessionId);
    this.sessions.delete(sessionId);
    await this.browserService.destroySession(sessionId, session.browserSession);
    await this.sessionStore.deleteSession(sessionId);

    try {
      await rm(this.browserService.getSessionProfileDir(sessionId), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.error("[viewer-be] failed to remove session profile", {
        sessionId,
        error: String(error),
      });
    }

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
    await this.sessionStore.dispose();
  }

  private async restorePersistedSessions(): Promise<void> {
    const records = await this.sessionStore.listSessions();
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
        if (record.connected) {
          await this.sessionStore.updateSessionConnection({
            sessionId: record.id,
            connected: false,
            lastActivityAt: record.lastActivityAt,
          });
        }
      } catch (error) {
        console.error("[viewer-be] failed to restore session", {
          sessionId: record.id,
          error: String(error),
        });
      }
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
