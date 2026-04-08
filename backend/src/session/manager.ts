import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import type {
  CollaborationState,
  CreateSessionSource,
  SessionHeaders,
} from "@browser-viewer/shared";
import { v4 as uuidv4 } from "uuid";
import {
  BrowserService,
  type BrowserSession,
  type LaunchBrowserSessionOptions,
} from "../browser/service";
import { QualityProbeStore } from "../quality/probe-store";
import type { PersistedSessionRecord, SessionStore } from "./store";

export interface SessionRecord {
  id: string;
  name: string;
  preferredForAi: boolean;
  proxyEnabled: boolean;
  sourceType: "launch" | "connect-cdp";
  cdpEndpoint?: string;
  headers: SessionHeaders;
  createdAt: Date;
  lastActivityAt: Date;
  connected: boolean;
  collaboration: CollaborationState;
  persisted: boolean;
  profilePath: string | null;
  browserSession: BrowserSession;
}

export interface CreateSessionOptions {
  name: string;
  preferredForAi?: boolean;
  source?: CreateSessionSource;
}

export interface SessionManagerOptions {
  restorePersistedSessions?: boolean;
  qualityProbeStore?: QualityProbeStore;
}

interface AiBridgeIssuedOptions {
  collaborationTabId?: string | null;
  issuedAt?: string;
}

function buildLaunchBrowserSessionOptions(session: {
  profilePath: string;
  proxyEnabled: boolean;
  headers: SessionHeaders;
}): LaunchBrowserSessionOptions {
  return {
    type: "launch",
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
    name: record.name,
    preferredForAi: record.preferredForAi ?? false,
    proxyEnabled: record.proxyEnabled,
    sourceType: "launch",
    cdpEndpoint: undefined,
    headers: record.headers,
    createdAt: new Date(record.createdAt),
    lastActivityAt: new Date(record.lastActivityAt),
    connected: false,
    collaboration: createDefaultCollaborationState(),
    persisted: true,
    profilePath: record.profilePath,
    browserSession,
  };
}

function createDefaultCollaborationState(): CollaborationState {
  return {
    controlOwner: "none",
    aiStatus: "idle",
    collaborationTabId: null,
    aiBridgeIssuedAt: null,
    aiBridgeExpiresAt: null,
    aiLastAction: null,
    aiLastError: null,
  };
}

function buildPersistedSessionRecord(
  session: SessionRecord,
): PersistedSessionRecord {
  return {
    id: session.id,
    name: session.name,
    preferredForAi: session.preferredForAi,
    proxyEnabled: session.proxyEnabled,
    connected: false,
    profilePath: session.profilePath ?? "",
    profileMode: "managed",
    headers: session.headers,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
  };
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly restorePersistedSessionsEnabled: boolean;
  private readonly qualityProbeStore: QualityProbeStore | null;

  constructor(
    private readonly browserService: BrowserService,
    private readonly sessionStore: SessionStore,
    options?: SessionManagerOptions,
  ) {
    super();
    this.restorePersistedSessionsEnabled =
      options?.restorePersistedSessions ?? true;
    this.qualityProbeStore = options?.qualityProbeStore ?? null;
  }

  async initialize(): Promise<void> {
    await this.sessionStore.initialize();
    if (!this.restorePersistedSessionsEnabled) {
      return;
    }
    await this.restorePersistedSessions();
  }

  async createSession(options: CreateSessionOptions): Promise<SessionRecord> {
    const sessionId = uuidv4();
    const source = options.source ?? { type: "launch" };
    if (options.preferredForAi && source.type !== "launch") {
      throw new Error("Preferred AI session must be persisted");
    }

    if (source.type === "connect-cdp") {
      const browserSession = await this.browserService.createSession(
        sessionId,
        source,
      );
      const session: SessionRecord = {
        id: sessionId,
        name: options.name,
        preferredForAi: false,
        proxyEnabled: false,
        sourceType: "connect-cdp",
        cdpEndpoint: source.endpoint,
        headers: {},
        createdAt: new Date(),
        lastActivityAt: new Date(),
        connected: false,
        collaboration: createDefaultCollaborationState(),
        persisted: false,
        profilePath: null,
        browserSession,
      };

      this.sessions.set(session.id, session);
      this.qualityProbeStore?.createSession(session.id);
      if (options.preferredForAi) {
        await this.updateSessionAiPreference(session.id, true);
      }
      return session;
    }

    const profilePath = this.browserService.getSessionProfileDir(sessionId);
    const proxyEnabled = source.proxyEnabled ?? false;
    const headers = source.headers ?? {};
    const browserSession = await this.browserService.createSession(
      sessionId,
      buildLaunchBrowserSessionOptions({
        profilePath,
        proxyEnabled,
        headers,
      }),
    );
    const session: SessionRecord = {
      id: sessionId,
      name: options.name,
      preferredForAi: false,
      proxyEnabled,
      sourceType: "launch",
      persisted: true,
      profilePath,
      headers,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      connected: false,
      collaboration: createDefaultCollaborationState(),
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
    this.qualityProbeStore?.createSession(session.id);
    if (options.preferredForAi) {
      await this.updateSessionAiPreference(session.id, true);
    }
    return session;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  async updateSessionName(
    sessionId: string,
    name: string,
  ): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    session.name = name;
    if (session.persisted) {
      await this.sessionStore.updateSessionName(sessionId, name);
    }

    return session;
  }

  async updateSessionAiPreference(
    sessionId: string,
    preferredForAi: boolean,
  ): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    if (preferredForAi && !session.persisted) {
      throw new Error("Preferred AI session must be persisted");
    }

    for (const candidate of this.sessions.values()) {
      candidate.preferredForAi =
        preferredForAi && candidate.id === sessionId;
    }

    const persistedSessionId =
      preferredForAi && session.persisted ? sessionId : null;
    await this.sessionStore.setPreferredForAiSession(persistedSessionId);

    return session;
  }

  markConnected(sessionId: string, connected: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.lastActivityAt = new Date();
    session.connected = connected;
    this.qualityProbeStore?.markViewerConnected(sessionId, connected);
    if (connected) {
      this.cancelPendingDestroy(sessionId);
    }

    if (!session.persisted) {
      return;
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
    this.qualityProbeStore?.destroySession(sessionId);
    await this.browserService.destroySession(sessionId, session.browserSession);

    if (session.persisted) {
      await this.sessionStore.deleteSession(sessionId);
    }

    try {
      if (session.profilePath) {
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

  getCollaborationState(sessionId: string): CollaborationState | undefined {
    return this.sessions.get(sessionId)?.collaboration;
  }

  /**
   * AI collaboration state transitions are intentionally centralized here.
   *
   * Canonical transitions:
   * - issue bridge: owner stays none, status becomes attached
   * - AI sends CDP method: owner becomes ai, status becomes running
   * - AI bridge error: keep owner, status becomes error
   * - AI bridge disconnect: owner becomes none, status becomes idle
   * - AI bridge revoke: owner becomes none, status becomes idle, clear action/error
   * - viewer selects tab: keep owner/status, update collaborationTabId
   * - human input: attached/running stays unchanged; otherwise owner becomes human
   *
   * Routes and websocket layers should emit these events instead of patching
   * CollaborationState directly.
   */
  onAiBridgeIssued(
    sessionId: string,
    options?: AiBridgeIssuedOptions,
  ): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      aiStatus: "attached",
      collaborationTabId:
        options?.collaborationTabId ?? current.collaborationTabId,
      aiBridgeIssuedAt: options?.issuedAt ?? new Date().toISOString(),
      aiBridgeExpiresAt: null,
      aiLastError: null,
    }));
  }

  onAiBridgeConnected(sessionId: string): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      aiStatus: "attached",
      aiLastError: null,
    }));
  }

  onAiMessage(
    sessionId: string,
    aiLastAction: string,
  ): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      controlOwner: "ai",
      aiStatus: "running",
      aiLastAction,
      aiLastError: null,
    }));
  }

  onAiBridgeError(
    sessionId: string,
    aiLastError: string,
  ): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      aiStatus: "error",
      aiLastError,
    }));
  }

  onAiBridgeDisconnected(sessionId: string): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      controlOwner: "none",
      aiStatus: "idle",
      aiBridgeIssuedAt: null,
      aiBridgeExpiresAt: null,
    }));
  }

  onAiBridgeRevoked(sessionId: string): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      controlOwner: "none",
      aiStatus: "idle",
      aiBridgeIssuedAt: null,
      aiBridgeExpiresAt: null,
      aiLastAction: null,
      aiLastError: null,
    }));
  }

  onCollaborationTabSelected(
    sessionId: string,
    collaborationTabId: string,
  ): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => ({
      ...current,
      collaborationTabId,
    }));
  }

  onHumanInput(sessionId: string): CollaborationState | undefined {
    return this.applyCollaborationState(sessionId, (current) => {
      if (current.aiStatus === "attached" || current.aiStatus === "running") {
        return current;
      }

      return {
        ...current,
        controlOwner: "human",
      };
    });
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
      buildLaunchBrowserSessionOptions(record),
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
  }

  private cancelPendingDestroy(sessionId: string): void {
    const timer = this.disconnectTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.disconnectTimers.delete(sessionId);
  }

  private applyCollaborationState(
    sessionId: string,
    update: (current: CollaborationState) => CollaborationState,
  ): CollaborationState | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    const next = update(session.collaboration);
    if (next === session.collaboration) {
      return session.collaboration;
    }

    session.collaboration = next;
    this.emit("collaboration-updated", sessionId, session.collaboration);
    return session.collaboration;
  }
}
