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
  buildPanelRecord,
  buildPanelWorkspaceRecord,
  buildSessionRecord,
  createRuntimeRecord,
  toPersistedProject,
  toPersistedPanel,
  toPersistedPanelWorkspace,
  toPersistedSession,
  type CreateTerminalSessionOptions,
  type TerminalPanelRecord,
  type TerminalPanelWorkspaceRecord,
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
  TerminalPanelRecord,
  TerminalPanelWorkspaceRecord,
  TerminalProjectRecord,
  TerminalSessionRecord,
} from "./manager-records";
import { getInitialTerminalActiveCommand } from "./session-launch";
import { createUniqueTerminalSessionId } from "./session-id";
import {
  getCompletionSourceForCommand,
  type LastAiActiveCommandRecord,
} from "./completion-source-gate";
import { getAgentForCommand, getTerminalSessionAgent } from "./terminal-state-service";

const SCROLLBACK_FLUSH_DELAY_MS = 250;
const ACTIVITY_FLUSH_DELAY_MS = 10_000;

export class TerminalSessionManager {
  private readonly projects = new Map<string, TerminalProjectRecord>();
  private readonly sessions = new Map<string, RuntimeTerminalSessionRecord>();
  private readonly panels = new Map<string, TerminalPanelRecord>();
  private readonly panelWorkspaces = new Map<
    string,
    TerminalPanelWorkspaceRecord
  >();
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
    const persistedPanels = await this.sessionStore.listPanels();
    const persistedPanelWorkspaces =
      await this.sessionStore.listPanelWorkspaces();

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
    for (const persisted of persistedPanels) {
      if (this.sessions.has(persisted.terminalSessionId)) {
        this.panels.set(persisted.id, buildPanelRecord(persisted));
      }
    }
    for (const persisted of persistedPanelWorkspaces) {
      if (this.sessions.has(persisted.terminalSessionId)) {
        this.panelWorkspaces.set(
          persisted.terminalSessionId,
          buildPanelWorkspaceRecord(persisted),
        );
      }
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
      panelSplitEnabled: false,
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

  listPanels(terminalSessionId: string): TerminalPanelRecord[] {
    const workspace = this.panelWorkspaces.get(terminalSessionId);
    if (!workspace) {
      return [];
    }
    return workspace.panelIds
      .map((panelId) => this.panels.get(panelId))
      .filter((panel): panel is TerminalPanelRecord => Boolean(panel));
  }

  getPanel(panelId: string): TerminalPanelRecord | undefined {
    return this.panels.get(panelId);
  }

  getPanelWorkspace(
    terminalSessionId: string,
  ): TerminalPanelWorkspaceRecord | undefined {
    return this.panelWorkspaces.get(terminalSessionId);
  }

  async upsertPanelWorkspace(
    workspace: TerminalPanelWorkspaceRecord,
  ): Promise<TerminalPanelWorkspaceRecord> {
    this.panelWorkspaces.set(workspace.terminalSessionId, {
      ...workspace,
      panelIds: [...workspace.panelIds],
    });
    await this.sessionStore.updatePanelWorkspace({
      workspace: toPersistedPanelWorkspace(workspace),
    });
    return workspace;
  }

  async upsertPanel(panel: TerminalPanelRecord): Promise<TerminalPanelRecord> {
    this.panels.set(panel.id, panel);
    await this.sessionStore.upsertPanel({ panel: toPersistedPanel(panel) });
    return panel;
  }

  async focusPanel(
    terminalSessionId: string,
    panelId: string,
  ): Promise<TerminalPanelWorkspaceRecord | undefined> {
    const workspace = this.panelWorkspaces.get(terminalSessionId);
    if (!workspace || !workspace.panelIds.includes(panelId)) {
      return undefined;
    }
    if (workspace.activePanelId === panelId) {
      return workspace;
    }
    workspace.activePanelId = panelId;
    await this.sessionStore.updatePanelWorkspace({
      workspace: toPersistedPanelWorkspace(workspace),
    });
    return workspace;
  }

  async removePanelFromWorkspace(
    terminalSessionId: string,
    panelId: string,
    fallbackPanelId?: string,
  ): Promise<TerminalPanelWorkspaceRecord | undefined> {
    const workspace = this.panelWorkspaces.get(terminalSessionId);
    if (!workspace) {
      return undefined;
    }
    const nextPanelIds = workspace.panelIds.filter((id) => id !== panelId);
    const activePanelId = nextPanelIds.includes(workspace.activePanelId)
      ? workspace.activePanelId
      : fallbackPanelId && nextPanelIds.includes(fallbackPanelId)
        ? fallbackPanelId
        : nextPanelIds[0] ?? "";
    const nextWorkspace = {
      ...workspace,
      activePanelId,
      panelIds: nextPanelIds,
    };
    this.panelWorkspaces.set(terminalSessionId, nextWorkspace);
    await this.sessionStore.updatePanelWorkspace({
      workspace: toPersistedPanelWorkspace(nextWorkspace),
    });
    return nextWorkspace;
  }

  async markPanelExited(panelId: string, exitCode?: number): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      return;
    }
    panel.status = "exited";
    panel.exitCode = exitCode;
    panel.lastActivityAt = new Date();
    await this.sessionStore.updatePanelStatus({
      panelId,
      status: "exited",
      lastActivityAt: panel.lastActivityAt.toISOString(),
      exitCode,
    });
  }

  async updatePanelThreadId(
    panelId: string,
    threadId: string | null,
  ): Promise<TerminalPanelRecord | undefined> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      return undefined;
    }

    const nextThreadId = threadId?.trim() || undefined;
    if (panel.threadId === nextThreadId) {
      return panel;
    }

    if (nextThreadId) {
      panel.threadId = nextThreadId;
    } else {
      delete panel.threadId;
    }
    await this.sessionStore.updatePanelThreadId({
      panelId,
      threadId: nextThreadId ?? null,
    });
    return panel;
  }

  async updatePanelPreview(
    panelId: string,
    preview: string | null,
  ): Promise<TerminalPanelRecord | undefined> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      return undefined;
    }

    const nextPreview = preview?.trim() || undefined;
    if (panel.preview === nextPreview) {
      return panel;
    }

    if (nextPreview) {
      panel.preview = nextPreview;
    } else {
      delete panel.preview;
    }
    await this.sessionStore.updatePanelPreview({
      panelId,
      preview: nextPreview ?? null,
    });
    return panel;
  }

  async updatePanelTerminalState(
    panelId: string,
    terminalState: TerminalState,
  ): Promise<TerminalPanelRecord | undefined> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      return undefined;
    }

    if (
      panel.terminalState?.state === terminalState.state &&
      panel.terminalState.agent === terminalState.agent
    ) {
      return panel;
    }

    panel.terminalState = terminalState;
    await this.sessionStore.updatePanelTerminalState({
      panelId,
      terminalState,
    });
    return panel;
  }

  async clearPanelsForSession(terminalSessionId: string): Promise<void> {
    for (const panel of this.panels.values()) {
      if (panel.terminalSessionId === terminalSessionId) {
        this.panels.delete(panel.id);
      }
    }
    this.panelWorkspaces.delete(terminalSessionId);
    await this.sessionStore.deletePanelsForSession(terminalSessionId);
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

    const runningPanelCount = this.listPanels(terminalSessionId).filter(
      (panel) => panel.status === "running",
    ).length;
    const nextActiveCommand =
      runningPanelCount > 1 ? null : metadata.activeCommand;

    if (
      session.cwd === metadata.cwd &&
      session.activeCommand === nextActiveCommand
    ) {
      return session;
    }

    this.observeActiveCommand(terminalSessionId, nextActiveCommand);
    session.cwd = metadata.cwd;
    session.activeCommand = nextActiveCommand;
    const shouldClearCodexThreadMetadata =
      Boolean(session.threadId || session.preview) &&
      getTerminalSessionAgent(session) !== "codex";
    if (shouldClearCodexThreadMetadata) {
      this.clearCodexThreadMetadata(session);
    }
    const lastActivityAt = this.touchSessionActivity(session, "immediate");
    await this.sessionStore.updateSessionMetadata({
      terminalSessionId,
      cwd: metadata.cwd,
      activeCommand: nextActiveCommand,
      lastActivityAt: lastActivityAt.toISOString(),
    });
    if (shouldClearCodexThreadMetadata) {
      await this.persistClearedCodexThreadMetadata(terminalSessionId);
    }
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
    const shouldClearCodexThreadMetadata =
      Boolean(session.threadId || session.preview) &&
      getAgentForCommand(launch.command) !== "codex";
    if (shouldClearCodexThreadMetadata) {
      this.clearCodexThreadMetadata(session);
    }
    await this.sessionStore.updateSessionLaunch({
      terminalSessionId,
      command: launch.command,
      args: nextArgs,
    });
    if (shouldClearCodexThreadMetadata) {
      await this.persistClearedCodexThreadMetadata(terminalSessionId);
    }
    return session;
  }

  private clearCodexThreadMetadata(session: RuntimeTerminalSessionRecord): void {
    delete session.threadId;
    delete session.preview;
  }

  private async persistClearedCodexThreadMetadata(
    terminalSessionId: string,
  ): Promise<void> {
    await this.sessionStore.updateSessionThreadId({
      terminalSessionId,
      threadId: null,
    });
    await this.sessionStore.updateSessionPreview({
      terminalSessionId,
      preview: null,
    });
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

  async updateSessionPanelSplitEnabled(
    terminalSessionId: string,
    panelSplitEnabled: boolean,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }
    if (session.panelSplitEnabled === panelSplitEnabled) {
      return session;
    }
    session.panelSplitEnabled = panelSplitEnabled;
    await this.sessionStore.updateSessionPanelSplitEnabled({
      terminalSessionId,
      panelSplitEnabled,
    });
    return session;
  }

  async updateSessionThreadId(
    terminalSessionId: string,
    threadId: string | null,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const nextThreadId = threadId?.trim() || undefined;
    if (session.threadId === nextThreadId) {
      return session;
    }

    if (nextThreadId) {
      session.threadId = nextThreadId;
    } else {
      delete session.threadId;
    }
    await this.sessionStore.updateSessionThreadId({
      terminalSessionId,
      threadId: nextThreadId ?? null,
    });
    return session;
  }

  async updateSessionPreview(
    terminalSessionId: string,
    preview: string | null,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const nextPreview = preview?.trim() || undefined;
    if (session.preview === nextPreview) {
      return session;
    }

    if (nextPreview) {
      session.preview = nextPreview;
    } else {
      delete session.preview;
    }
    await this.sessionStore.updateSessionPreview({
      terminalSessionId,
      preview: nextPreview ?? null,
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
    for (const panel of this.panels.values()) {
      if (panel.terminalSessionId === terminalSessionId) {
        this.panels.delete(panel.id);
      }
    }
    this.panelWorkspaces.delete(terminalSessionId);
    await this.sessionStore.deletePanelsForSession(terminalSessionId);
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
