import { constants } from "node:fs";
import { access, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { BrowserService, type BrowserSession } from "../browser/service";
import { expandHomePath } from "../utils/path";
import type { SessionStore } from "./store";
import type { SessionProfileMode } from "./store";

export class SessionProfileValidationError extends Error {}

export class SessionProfileConflictError extends Error {}

export interface SessionRecord {
  id: string;
  targetUrl: string;
  proxyEnabled: boolean;
  profilePath: string;
  profileMode: SessionProfileMode;
  createdAt: Date;
  lastActivityAt: Date;
  connected: boolean;
  browserSession: BrowserSession;
}

export interface CreateSessionOptions {
  targetUrl: string;
  proxyEnabled: boolean;
  profilePath?: string;
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
    const createdAt = new Date();
    const lastActivityAt = new Date();
    const { profileMode, profilePath } = await this.resolveProfileBinding(
      sessionId,
      options.profilePath,
    );
    const browserSession = await this.browserService.createSession(
      sessionId,
      options.targetUrl,
      {
        profilePath,
        proxyEnabled: options.proxyEnabled,
      },
    );

    try {
      await this.sessionStore.insertSession({
        id: sessionId,
        targetUrl: options.targetUrl,
        proxyEnabled: options.proxyEnabled,
        connected: false,
        profilePath,
        profileMode,
        createdAt: createdAt.toISOString(),
        lastActivityAt: lastActivityAt.toISOString(),
      });
    } catch (error) {
      await this.browserService.destroySession(sessionId, browserSession);
      throw error;
    }

    const session: SessionRecord = {
      id: sessionId,
      targetUrl: options.targetUrl,
      proxyEnabled: options.proxyEnabled,
      profilePath,
      profileMode,
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
        const browserSession = await this.browserService.restoreSession(
          record.id,
          record.targetUrl,
          {
            profilePath: record.profilePath,
            proxyEnabled: record.proxyEnabled,
          },
        );
        this.sessions.set(record.id, {
          id: record.id,
          targetUrl: record.targetUrl,
          proxyEnabled: record.proxyEnabled,
          profilePath: record.profilePath,
          profileMode: record.profileMode,
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

        try {
          await this.sessionStore.deleteSession(record.id);
        } catch (cleanupError) {
          console.error("[viewer-be] failed to delete stale session", {
            sessionId: record.id,
            error: String(cleanupError),
          });
        }
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

  private async resolveProfileBinding(
    sessionId: string,
    customProfilePath: string | undefined,
  ): Promise<{ profileMode: SessionProfileMode; profilePath: string }> {
    if (!customProfilePath) {
      return {
        profileMode: "managed",
        profilePath: this.browserService.getSessionProfileDir(sessionId),
      };
    }

    const resolvedProfilePath = path.resolve(
      expandHomePath(customProfilePath, os.homedir()) ?? customProfilePath,
    );
    await this.validateCustomProfilePath(resolvedProfilePath);
    this.ensureProfilePathAvailable(resolvedProfilePath);

    return {
      profileMode: "custom",
      profilePath: resolvedProfilePath,
    };
  }

  private ensureProfilePathAvailable(profilePath: string): void {
    const existingSession = Array.from(this.sessions.values()).find(
      (session) => session.profilePath === profilePath,
    );

    if (!existingSession) {
      return;
    }

    throw new SessionProfileConflictError(
      "Custom profile path is already in use by another session",
    );
  }

  private async validateCustomProfilePath(profilePath: string): Promise<void> {
    let profileStats;
    try {
      profileStats = await stat(profilePath);
    } catch {
      throw new SessionProfileValidationError(
        "Custom profile path does not exist",
      );
    }

    if (!profileStats.isDirectory()) {
      throw new SessionProfileValidationError(
        "Custom profile path must point to a directory",
      );
    }

    try {
      await access(profilePath, constants.R_OK | constants.W_OK);
    } catch {
      throw new SessionProfileValidationError(
        "Custom profile path must be readable and writable",
      );
    }
  }
}
