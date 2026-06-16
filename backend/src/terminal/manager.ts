import { v4 as uuidv4 } from "uuid";
import {
  TERMINAL_CLIENT_SCROLLBACK_LINES,
  TERMINAL_LIVE_SCROLLBACK_BYTES,
  type TerminalState,
} from "@runweave/shared";
import type {
  TerminalSessionStore,
  TerminalRuntimeMetadata,
} from "./store";
import {
  appendToScrollbackBuffer,
  createScrollbackBuffer,
  readScrollbackBuffer,
  readScrollbackBufferTailLines,
} from "./scrollback-buffer";
import {
  buildProjectRecord,
  buildSessionRecord,
  createRuntimeRecord,
  toPersistedProject,
  toPersistedSession,
  type CreateTerminalSessionOptions,
  type RuntimeTerminalSessionRecord,
  type TerminalProjectRecord,
  type TerminalSessionRecord,
} from "./manager-records";
import {
  applyProjectOrder,
  applySessionOrder,
  sortTerminalProjects,
  sortTerminalSessions,
} from "./manager-ordering";
import { isExistingDirectory } from "./manager-path";
export type {
  CreateTerminalSessionOptions,
  TerminalProjectRecord,
  TerminalSessionRecord,
} from "./manager-records";
import { getInitialTerminalActiveCommand } from "./session-launch";
import { createUniqueTerminalSessionId } from "./session-id";
import {
  getCompletionSourceForCommand,
  type LastAiActiveCommandRecord,
} from "./completion-source-gate";

const SCROLLBACK_FLUSH_DELAY_MS = 250;
const ACTIVITY_FLUSH_DELAY_MS = 10_000;

export class TerminalSessionManager {
  private readonly projects = new Map<string, TerminalProjectRecord>();
  private readonly sessions = new Map<string, RuntimeTerminalSessionRecord>();
  private readonly lastAiActiveCommands = new Map<
    string,
    LastAiActiveCommandRecord
  >();
  private readonly scrollbackFlushTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingScrollbackChunks = new Map<string, string[]>();
  private readonly activityFlushTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingActivityUpdates = new Map<string, Date>();

  constructor(private readonly sessionStore: TerminalSessionStore) {}

  async initialize(): Promise<void> {
    await this.sessionStore.initialize();
    const persistedProjects = await this.sessionStore.listProjects();
    const persistedSessions = await this.sessionStore.listSessionMetadata();

    for (const persisted of persistedProjects) {
      this.projects.set(persisted.id, buildProjectRecord(persisted));
    }
    for (const persisted of persistedSessions) {
      this.sessions.set(
        persisted.id,
        createRuntimeRecord(buildSessionRecord(persisted), {
          scrollbackLoaded: false,
        }),
      );
    }
  }

  listProjects(): TerminalProjectRecord[] {
    return sortTerminalProjects(this.projects.values());
  }

  getProject(projectId: string): TerminalProjectRecord | undefined {
    return this.projects.get(projectId);
  }

  async createProject(
    name: string,
    projectPath?: string | null,
  ): Promise<TerminalProjectRecord> {
    const project: TerminalProjectRecord = {
      id: uuidv4(),
      name: name.trim(),
      path: projectPath?.trim() || null,
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
    patch: { name?: string; path?: string | null },
  ): Promise<TerminalProjectRecord | undefined> {
    const project = this.projects.get(projectId);
    if (!project) {
      return undefined;
    }

    if (patch.name !== undefined) {
      project.name = patch.name.trim();
    }
    if ("path" in patch) {
      project.path = patch.path?.trim() || null;
    }
    await this.sessionStore.updateProject({
      projectId,
      name: project.name,
      path: project.path,
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

  async reorderProjects(orderedIds: string[]): Promise<void> {
    applyProjectOrder(this.projects.values(), orderedIds);
    await this.sessionStore.reorderProjects(orderedIds);
  }

  async reorderSessions(
    projectId: string,
    orderedIds: string[],
  ): Promise<void> {
    applySessionOrder(this.sessions.values(), projectId, orderedIds);
    await this.sessionStore.reorderSessions(projectId, orderedIds);
  }

  private getDefaultProjectId(): string {
    const currentDefault = this.listProjects().find(
      (project) => project.isDefault,
    );
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
    const session = createRuntimeRecord({
      id: createUniqueTerminalSessionId((candidate) =>
        this.sessions.has(candidate),
      ),
      projectId,
      alias: null,
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      activeCommand: getInitialTerminalActiveCommand(options.command),
      scrollback: "",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
      runtimeKind: "pty",
      recoverable: false,
    });

    await this.sessionStore.insertSession(toPersistedSession(session));
    this.sessions.set(session.id, session);
    this.observeActiveCommand(session.id, session.activeCommand);
    return session;
  }

  getScrollback(terminalSessionId: string): string {
    const session = this.sessions.get(terminalSessionId);
    if (!session?.scrollbackLoaded) {
      return "";
    }

    return session.scrollback;
  }

  async readScrollback(terminalSessionId: string): Promise<string> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return "";
    }

    if (!session.scrollbackLoaded) {
      await this.flushScrollback(terminalSessionId);
      session.scrollbackBuffer = createScrollbackBuffer(
        await this.sessionStore.readSessionScrollback(terminalSessionId),
      );
      session.scrollbackLoaded = true;
    }

    return session.scrollback;
  }

  getLiveScrollback(terminalSessionId: string): string {
    const session = this.sessions.get(terminalSessionId);
    if (!session?.scrollbackLoaded) {
      return "";
    }

    return readScrollbackBuffer(
      createScrollbackBuffer(
        readScrollbackBufferTailLines(
          session.scrollbackBuffer,
          TERMINAL_CLIENT_SCROLLBACK_LINES,
        ),
        TERMINAL_LIVE_SCROLLBACK_BYTES,
      ),
    );
  }

  async readLiveScrollback(terminalSessionId: string): Promise<string> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return "";
    }

    if (!session.scrollbackLoaded) {
      await this.flushScrollback(terminalSessionId);
      return this.sessionStore.readSessionLiveScrollback(terminalSessionId);
    }

    return this.getLiveScrollback(terminalSessionId);
  }

  appendOutput(terminalSessionId: string, chunk: string): void {
    if (!chunk) {
      return;
    }

    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    appendToScrollbackBuffer(session.scrollbackBuffer, chunk);
    this.touchSessionActivity(session, "deferred");
    const pendingChunks = this.pendingScrollbackChunks.get(terminalSessionId);
    if (pendingChunks) {
      pendingChunks.push(chunk);
    } else {
      this.pendingScrollbackChunks.set(terminalSessionId, [chunk]);
    }
    this.scheduleScrollbackFlush(terminalSessionId);
  }

  getSession(terminalSessionId: string): TerminalSessionRecord | undefined {
    return this.sessions.get(terminalSessionId);
  }

  listSessions(): TerminalSessionRecord[] {
    return sortTerminalSessions(this.sessions.values());
  }

  markExited(terminalSessionId: string, exitCode?: number): void {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    session.status = "exited";
    session.exitCode = exitCode;
    const lastActivityAt = this.touchSessionActivity(session, "immediate");
    void this.sessionStore.updateSessionExit({
      terminalSessionId,
      status: "exited",
      lastActivityAt: lastActivityAt.toISOString(),
      exitCode,
    });
  }

  markRunning(terminalSessionId: string): void {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    session.status = "running";
    session.exitCode = undefined;
    const lastActivityAt = this.touchSessionActivity(session, "immediate");
    void this.sessionStore.updateSessionStatus({
      terminalSessionId,
      status: "running",
      lastActivityAt: lastActivityAt.toISOString(),
      exitCode: undefined,
    });
  }

  async updateSessionMetadata(
    terminalSessionId: string,
    metadata: {
      cwd: string;
      activeCommand: string | null;
    },
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    if (!isExistingDirectory(metadata.cwd)) {
      return session;
    }

    if (
      session.cwd === metadata.cwd &&
      session.activeCommand === metadata.activeCommand
    ) {
      return session;
    }

    this.observeActiveCommand(terminalSessionId, metadata.activeCommand);
    session.cwd = metadata.cwd;
    session.activeCommand = metadata.activeCommand;
    const lastActivityAt = this.touchSessionActivity(session, "immediate");
    await this.sessionStore.updateSessionMetadata({
      terminalSessionId,
      cwd: metadata.cwd,
      activeCommand: metadata.activeCommand,
      lastActivityAt: lastActivityAt.toISOString(),
    });
    return session;
  }

  getLastAiActiveCommand(
    terminalSessionId: string,
  ): LastAiActiveCommandRecord | null {
    return this.lastAiActiveCommands.get(terminalSessionId) ?? null;
  }

  async updateSessionLaunch(
    terminalSessionId: string,
    launch: {
      command: string;
      args: string[];
    },
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const nextArgs = [...launch.args];
    const commandUnchanged = session.command === launch.command;
    const argsUnchanged =
      session.args.length === nextArgs.length &&
      session.args.every((arg, index) => arg === nextArgs[index]);
    if (commandUnchanged && argsUnchanged) {
      return session;
    }

    session.command = launch.command;
    session.args = nextArgs;
    await this.sessionStore.updateSessionLaunch({
      terminalSessionId,
      command: launch.command,
      args: nextArgs,
    });
    return session;
  }

  async updateSessionAlias(
    terminalSessionId: string,
    alias: string | null,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const nextAlias = alias?.trim() || null;
    if (session.alias === nextAlias) {
      return session;
    }

    session.alias = nextAlias;
    await this.sessionStore.updateSessionAlias({
      terminalSessionId,
      alias: nextAlias,
    });
    return session;
  }

  async updateRuntimeMetadata(
    terminalSessionId: string,
    metadata: TerminalRuntimeMetadata,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    session.runtimeKind = metadata.runtimeKind;
    session.tmuxSessionName = metadata.tmuxSessionName;
    session.tmuxSocketPath = metadata.tmuxSocketPath;
    session.tmuxUnavailableReason = metadata.tmuxUnavailableReason;
    session.recoverable = metadata.recoverable;
    await this.sessionStore.updateSessionRuntimeMetadata({
      terminalSessionId,
      runtimeKind: metadata.runtimeKind,
      tmuxSessionName: metadata.tmuxSessionName,
      tmuxSocketPath: metadata.tmuxSocketPath,
      tmuxUnavailableReason: metadata.tmuxUnavailableReason,
      recoverable: metadata.recoverable,
    });
    return session;
  }

  async updateSessionTerminalState(
    terminalSessionId: string,
    terminalState: TerminalState,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    if (
      session.terminalState?.state === terminalState.state &&
      session.terminalState.agent === terminalState.agent
    ) {
      return session;
    }

    session.terminalState = terminalState;
    await this.sessionStore.updateSessionTerminalState({
      terminalSessionId,
      terminalState,
    });
    return session;
  }

  async destroySession(terminalSessionId: string): Promise<boolean> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return false;
    }

    this.clearPendingScrollbackFlush(terminalSessionId);
    this.pendingScrollbackChunks.delete(terminalSessionId);
    this.clearPendingActivityFlush(terminalSessionId);
    this.pendingActivityUpdates.delete(terminalSessionId);
    this.lastAiActiveCommands.delete(terminalSessionId);
    this.sessions.delete(terminalSessionId);
    await this.sessionStore.deleteSession(terminalSessionId);
    return true;
  }

  private observeActiveCommand(
    terminalSessionId: string,
    activeCommand: string | null,
  ): void {
    const now = Date.now();
    const source = getCompletionSourceForCommand(activeCommand);
    if (source && activeCommand) {
      this.lastAiActiveCommands.set(terminalSessionId, {
        command: activeCommand,
        source,
        observedAt: now,
        clearedAt: null,
      });
      return;
    }

    if (activeCommand !== null) {
      this.lastAiActiveCommands.delete(terminalSessionId);
      return;
    }

    const previous = this.lastAiActiveCommands.get(terminalSessionId);
    if (!previous || previous.clearedAt !== null) {
      return;
    }
    this.lastAiActiveCommands.set(terminalSessionId, {
      ...previous,
      clearedAt: now,
    });
  }

  async dispose(): Promise<void> {
    await this.flushAllPendingScrollback();
    await this.flushAllPendingActivity();
    await this.sessionStore.dispose();
  }

  private touchSessionActivity(
    session: RuntimeTerminalSessionRecord,
    persistence: "deferred" | "immediate",
  ): Date {
    const lastActivityAt = new Date();
    session.lastActivityAt = lastActivityAt;
    if (persistence === "immediate") {
      this.clearPendingActivityFlush(session.id);
      this.pendingActivityUpdates.delete(session.id);
      return lastActivityAt;
    }
    this.pendingActivityUpdates.set(session.id, lastActivityAt);
    this.scheduleActivityFlush(session.id);
    return lastActivityAt;
  }

  private scheduleActivityFlush(terminalSessionId: string): void {
    this.clearPendingActivityFlush(terminalSessionId);

    const timer = setTimeout(() => {
      this.activityFlushTimers.delete(terminalSessionId);
      void this.flushActivity(terminalSessionId);
    }, ACTIVITY_FLUSH_DELAY_MS);
    this.activityFlushTimers.set(terminalSessionId, timer);
  }

  private clearPendingActivityFlush(terminalSessionId: string): void {
    const timer = this.activityFlushTimers.get(terminalSessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.activityFlushTimers.delete(terminalSessionId);
  }

  private async flushActivity(terminalSessionId: string): Promise<void> {
    if (!this.sessions.has(terminalSessionId)) {
      this.pendingActivityUpdates.delete(terminalSessionId);
      return;
    }

    const lastActivityAt = this.pendingActivityUpdates.get(terminalSessionId);
    if (!lastActivityAt) {
      return;
    }
    this.pendingActivityUpdates.delete(terminalSessionId);

    await this.sessionStore.updateSessionActivity({
      terminalSessionId,
      lastActivityAt: lastActivityAt.toISOString(),
    });
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
    if (!this.sessions.has(terminalSessionId)) {
      this.pendingScrollbackChunks.delete(terminalSessionId);
      return;
    }

    const pendingChunks = this.pendingScrollbackChunks.get(terminalSessionId);
    if (!pendingChunks?.length) {
      return;
    }
    this.pendingScrollbackChunks.delete(terminalSessionId);

    await this.sessionStore.appendSessionScrollback({
      terminalSessionId,
      chunk: pendingChunks.join(""),
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

  private async flushAllPendingActivity(): Promise<void> {
    const pendingSessionIds = Array.from(this.activityFlushTimers.keys());
    pendingSessionIds.forEach((terminalSessionId) =>
      this.clearPendingActivityFlush(terminalSessionId),
    );
    await Promise.all(
      pendingSessionIds.map((terminalSessionId) =>
        this.flushActivity(terminalSessionId),
      ),
    );
  }
}
