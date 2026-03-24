import { rm } from "node:fs/promises";
import type { SessionHeaders } from "@browser-viewer/shared";
import { v4 as uuidv4 } from "uuid";
import {
  BrowserService,
  type BrowserSession,
  type BrowserSessionOptions,
} from "../browser/service";
import {
  resolveSessionProfileBinding,
  SessionProfileConflictError,
  SessionProfileValidationError,
} from "./profile-binding";
import type {
  PersistedSessionRecord,
  SessionProfileMode,
  SessionStore,
} from "./store";

export { SessionProfileConflictError, SessionProfileValidationError };

export interface SessionRecord {
  id: string;
  targetUrl: string;
  proxyEnabled: boolean;
  profilePath: string;
  profileMode: SessionProfileMode;
  headers: SessionHeaders;
  createdAt: Date;
  lastActivityAt: Date;
  connected: boolean;
  browserSession: BrowserSession;
}

export interface CreateSessionOptions {
  targetUrl: string;
  proxyEnabled: boolean;
  profilePath?: string;
  headers?: SessionHeaders;
}

function buildBrowserSessionOptions(session: {
  profilePath: string;
  proxyEnabled: boolean;
  headers: SessionHeaders;
}): BrowserSessionOptions {
  return {
    profilePath: session.profilePath,
    proxyEnabled: session.proxyEnabled,
    headers: session.headers,
  };
}

function buildSessionRecord(
  record: PersistedSessionRecord,
  browserSession: BrowserSession,
): SessionRecord {
  return {
    id: record.id,
    targetUrl: record.targetUrl,
    proxyEnabled: record.proxyEnabled,
    profilePath: record.profilePath,
    profileMode: record.profileMode,
    headers: record.headers,
    createdAt: new Date(record.createdAt),
    lastActivityAt: new Date(record.lastActivityAt),
    connected: false,
    browserSession,
  };
}

function buildPersistedSessionRecord(
  session: SessionRecord,
): PersistedSessionRecord {
  return {
    id: session.id,
    targetUrl: session.targetUrl,
    proxyEnabled: session.proxyEnabled,
    connected: session.connected,
    profilePath: session.profilePath,
    profileMode: session.profileMode,
    headers: session.headers,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
  };
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

  async createSession(options: CreateSessionOptions): Promise<SessionRecord> {
    const sessionId = uuidv4();
    const headers = options.headers ?? {};
    const { profileMode, profilePath } = await resolveSessionProfileBinding({
      sessionId,
      customProfilePath: options.profilePath,
      activeProfilePaths: Array.from(
        this.sessions.values(),
        (session) => session.profilePath,
      ),
      getManagedProfilePath: (managedSessionId) =>
        this.browserService.getSessionProfileDir(managedSessionId),
    });
    const browserSession = await this.browserService.createSession(
      sessionId,
      options.targetUrl,
      buildBrowserSessionOptions({
        profilePath,
        proxyEnabled: options.proxyEnabled,
        headers,
      }),
    );
    const session: SessionRecord = {
      id: sessionId,
      targetUrl: options.targetUrl,
      proxyEnabled: options.proxyEnabled,
      profilePath,
      profileMode,
      headers,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      connected: false,
      browserSession,
    };

    try {
      await this.sessionStore.insertSession(
        buildPersistedSessionRecord(session),
      );
    } catch (error) {
      await this.browserService.destroySession(sessionId, browserSession);
      throw error;
    }

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
      if (session.profileMode === "managed") {
        await rm(session.profilePath, {
          recursive: true,
          force: true,
        });
      }
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

  getRemoteDebuggingPort(sessionId: string): number | null {
    return this.browserService.getRemoteDebuggingPort(sessionId);
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
        await this.restorePersistedSession(record);
      } catch (error) {
        await this.handleRestoreFailure(record.id, error);
      }
    }
  }

  private async restorePersistedSession(
    record: PersistedSessionRecord,
  ): Promise<void> {
    const browserSession = await this.browserService.restoreSession(
      record.id,
      record.targetUrl,
      buildBrowserSessionOptions(record),
    );

    this.sessions.set(record.id, buildSessionRecord(record, browserSession));
    await this.resetPersistedConnectionState(record);
  }

  private async resetPersistedConnectionState(
    record: PersistedSessionRecord,
  ): Promise<void> {
    if (!record.connected) {
      return;
    }

    await this.sessionStore.updateSessionConnection({
      sessionId: record.id,
      connected: false,
      lastActivityAt: record.lastActivityAt,
    });
  }

  private async handleRestoreFailure(
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    console.error("[viewer-be] failed to restore session", {
      sessionId,
      error: String(error),
    });

    try {
      await this.sessionStore.deleteSession(sessionId);
    } catch (cleanupError) {
      console.error("[viewer-be] failed to delete stale session", {
        sessionId,
        error: String(cleanupError),
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
