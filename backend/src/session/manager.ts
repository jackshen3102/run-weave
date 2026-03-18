import { v4 as uuidv4 } from "uuid";
import { BrowserService, type BrowserSession } from "../browser/service";

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
  private readonly ttlMs: number;
  private readonly disconnectGraceMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly browserService: BrowserService,
    options?: {
      ttlMs?: number;
      disconnectGraceMs?: number;
      cleanupIntervalMs?: number;
    },
  ) {
    this.ttlMs = options?.ttlMs ?? 10 * 60 * 1000;
    this.disconnectGraceMs = options?.disconnectGraceMs ?? 5000;
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? 30 * 1000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, cleanupIntervalMs);
  }

  async createSession(targetUrl: string): Promise<SessionRecord> {
    const browserSession = await this.browserService.createSession(targetUrl);
    const session: SessionRecord = {
      id: uuidv4(),
      targetUrl,
      createdAt: new Date(),
      lastActivityAt: new Date(),
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
      this.clearPendingDestroy(sessionId);
      return;
    }

    this.schedulePendingDestroy(sessionId);
  }

  async destroySession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.clearPendingDestroy(sessionId);
    this.sessions.delete(sessionId);
    await this.browserService.destroySession(session.browserSession);
    return true;
  }

  listSessions(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  async dispose(): Promise<void> {
    clearInterval(this.cleanupTimer);
    this.disconnectTimers.forEach((timer) => clearTimeout(timer));
    this.disconnectTimers.clear();
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.destroySession(id)));
    await this.browserService.stop();
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredIds = Array.from(this.sessions.values())
      .filter((session) => !session.connected && now - session.lastActivityAt.getTime() > this.ttlMs)
      .map((session) => session.id);

    await Promise.all(expiredIds.map((id) => this.destroySession(id)));
  }

  private schedulePendingDestroy(sessionId: string): void {
    this.clearPendingDestroy(sessionId);
    const timer = setTimeout(() => {
      void this.destroySession(sessionId);
    }, this.disconnectGraceMs);
    this.disconnectTimers.set(sessionId, timer);
  }

  private clearPendingDestroy(sessionId: string): void {
    const timer = this.disconnectTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.disconnectTimers.delete(sessionId);
  }
}
