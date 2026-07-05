import {
  appendFile,
  open,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  TERMINAL_COMPACTED_SCROLLBACK_BYTES,
  TERMINAL_LIVE_SCROLLBACK_BYTES,
  TERMINAL_PERSISTED_SCROLLBACK_BYTES,
} from "@runweave/shared";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  AppendTerminalSessionScrollbackParams,
  PersistedTerminalPanelRecord,
  PersistedTerminalPanelWorkspaceRecord,
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionMetadataRecord,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalPanelLastThreadParams,
  UpdateTerminalPanelPreviewParams,
  UpdateTerminalPanelStatusParams,
  UpdateTerminalPanelTerminalStateParams,
  UpdateTerminalPanelThreadIdParams,
  UpdateTerminalPanelWorkspaceParams,
  UpdateTerminalProjectParams,
  UpdateTerminalSessionExitParams,
  UpdateTerminalSessionStatusParams,
  UpdateTerminalSessionActivityParams,
  UpdateTerminalSessionAliasParams,
  UpdateTerminalSessionLaunchParams,
  UpdateTerminalSessionMetadataParams,
  UpdateTerminalSessionLastThreadParams,
  UpdateTerminalSessionPreviewParams,
  UpdateTerminalSessionPanelSplitEnabledParams,
  UpdateTerminalSessionRuntimeMetadataParams,
  UpdateTerminalSessionScrollbackParams,
  UpdateTerminalSessionTerminalStateParams,
  UpdateTerminalSessionThreadIdParams,
  UpsertTerminalPanelParams,
} from "./store";
import { getLiveTerminalScrollback } from "./live-scrollback";
import {
  createScrollbackBuffer,
  readScrollbackBuffer,
} from "./scrollback-buffer";

interface TerminalSessionStoreData {
  projects: PersistedTerminalProjectRecord[];
  sessions: PersistedTerminalSessionMetadataRecord[];
  panels: PersistedTerminalPanelRecord[];
  panelWorkspaces: PersistedTerminalPanelWorkspaceRecord[];
}

type LegacyTerminalSessionRecord = Partial<PersistedTerminalSessionRecord> & {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  createdAt: string;
  status: "running" | "exited";
  name?: string;
  alias?: string | null;
  projectId?: string;
  scrollback?: string;
  activeCommand?: string | null;
};

interface LegacyTerminalSessionStoreData {
  projects?: PersistedTerminalProjectRecord[];
  sessions?: LegacyTerminalSessionRecord[];
  panels?: PersistedTerminalPanelRecord[];
  panelWorkspaces?: PersistedTerminalPanelWorkspaceRecord[];
}

const DEFAULT_DATA: TerminalSessionStoreData = {
  projects: [],
  sessions: [],
  panels: [],
  panelWorkspaces: [],
};
const LIVE_SCROLLBACK_READ_BYTES = TERMINAL_LIVE_SCROLLBACK_BYTES + 4;

export class LowDbTerminalSessionStore implements TerminalSessionStore {
  private database: Low<TerminalSessionStoreData> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingScrollbackWrite: Promise<void> = Promise.resolve();
  private readonly scrollbackDir: string;

  constructor(private readonly storeFile: string) {
    this.scrollbackDir = path.join(
      path.dirname(storeFile),
      "terminal-scrollback",
    );
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storeFile), { recursive: true });
    await mkdir(this.scrollbackDir, { recursive: true });

    const database = new Low(
      new JSONFile<LegacyTerminalSessionStoreData>(this.storeFile),
      { ...DEFAULT_DATA },
    );
    await database.read();
    const rawData = database.data ?? { ...DEFAULT_DATA };
    const projects = [...(rawData.projects ?? [])];
    const sessions = [...(rawData.sessions ?? [])];
    const panels = [...(rawData.panels ?? [])];
    const panelWorkspaces = [...(rawData.panelWorkspaces ?? [])];

    if (projects.length === 0) {
      projects.push({
        id: crypto.randomUUID(),
        name: "Default Project",
        path: null,
        createdAt: new Date().toISOString(),
        isDefault: true,
      });
    }

    const defaultProjectId =
      projects.find((project) => project.isDefault)?.id ?? projects[0]?.id;
    const normalizedSessions: PersistedTerminalSessionMetadataRecord[] = [];
    for (const session of sessions) {
      const { scrollback, name: legacyName, ...metadata } = session;
      if (scrollback) {
        await this.writeScrollbackFile(session.id, scrollback);
      }
      normalizedSessions.push({
        ...metadata,
        alias: metadata.alias?.trim() || null,
        projectId: session.projectId ?? defaultProjectId ?? "",
        activeCommand: normalizeActiveCommand({
          activeCommand: session.activeCommand,
          command: session.command,
          cwd: session.cwd,
          legacyName,
        }),
        lastActivityAt: session.lastActivityAt ?? session.createdAt,
      });
    }

    database.data = {
      projects,
      sessions: normalizedSessions,
      panels,
      panelWorkspaces,
    };
    await database.write();
    this.database = database as unknown as Low<TerminalSessionStoreData>;
  }

  async dispose(): Promise<void> {
    await this.pendingWrite;
    await this.pendingScrollbackWrite;
    this.database = null;
  }

  async listSessions(): Promise<PersistedTerminalSessionRecord[]> {
    return this.getSessions();
  }

  async listSessionMetadata(): Promise<
    PersistedTerminalSessionMetadataRecord[]
  > {
    return this.getSessionMetadataRecords();
  }

  async listProjects(): Promise<PersistedTerminalProjectRecord[]> {
    return this.getProjects();
  }

  async getProject(
    projectId: string,
  ): Promise<PersistedTerminalProjectRecord | null> {
    return (
      this.getProjects().find((project) => project.id === projectId) ?? null
    );
  }

  async getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null> {
    const metadata =
      this.getSessionMetadataRecords().find(
        (session) => session.id === terminalSessionId,
      ) ?? null;
    if (!metadata) {
      return null;
    }

    return {
      ...metadata,
      scrollback: await this.readSessionScrollback(terminalSessionId),
    };
  }

  async listPanels(): Promise<PersistedTerminalPanelRecord[]> {
    return this.getPanels();
  }

  async listPanelWorkspaces(): Promise<
    PersistedTerminalPanelWorkspaceRecord[]
  > {
    return this.getPanelWorkspaces();
  }

  async upsertPanel(params: UpsertTerminalPanelParams): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const panel = structuredClone(params.panel);
      const index = database.data.panels.findIndex(
        (candidate) => candidate.id === panel.id,
      );
      if (index >= 0) {
        database.data.panels[index] = panel;
      } else {
        database.data.panels.push(panel);
      }
      await database.write();
    });
  }

  async updatePanelThreadId(
    params: UpdateTerminalPanelThreadIdParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const panel = database.data.panels.find(
        (candidate) => candidate.id === params.panelId,
      );
      if (!panel) {
        return;
      }
      if (params.threadId) {
        panel.threadId = params.threadId;
      } else {
        delete panel.threadId;
      }
      await database.write();
    });
  }

  async updatePanelPreview(
    params: UpdateTerminalPanelPreviewParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const panel = database.data.panels.find(
        (candidate) => candidate.id === params.panelId,
      );
      if (!panel) {
        return;
      }
      if (params.preview) {
        panel.preview = params.preview;
      } else {
        delete panel.preview;
      }
      await database.write();
    });
  }

  async updatePanelLastThread(
    params: UpdateTerminalPanelLastThreadParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const panel = database.data.panels.find(
        (candidate) => candidate.id === params.panelId,
      );
      if (!panel) {
        return;
      }
      panel.lastThreadId = params.threadId;
      panel.lastThreadStatus = params.status;
      panel.lastThreadUpdatedAt = params.updatedAt;
      await database.write();
    });
  }

  async updatePanelTerminalState(
    params: UpdateTerminalPanelTerminalStateParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const panel = database.data.panels.find(
        (candidate) => candidate.id === params.panelId,
      );
      if (!panel) {
        return;
      }
      panel.terminalState = params.terminalState;
      await database.write();
    });
  }

  async updatePanelStatus(
    params: UpdateTerminalPanelStatusParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const panel = database.data.panels.find(
        (candidate) => candidate.id === params.panelId,
      );
      if (!panel) {
        return;
      }
      panel.status = params.status;
      if (params.lastActivityAt !== undefined) {
        panel.lastActivityAt = params.lastActivityAt;
      }
      if (params.exitCode !== undefined) {
        panel.exitCode = params.exitCode;
      } else {
        delete panel.exitCode;
      }
      await database.write();
    });
  }

  async updatePanelWorkspace(
    params: UpdateTerminalPanelWorkspaceParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const workspace = structuredClone(params.workspace);
      const index = database.data.panelWorkspaces.findIndex(
        (candidate) =>
          candidate.terminalSessionId === workspace.terminalSessionId,
      );
      if (index >= 0) {
        database.data.panelWorkspaces[index] = workspace;
      } else {
        database.data.panelWorkspaces.push(workspace);
      }
      await database.write();
    });
  }

  async deletePanelsForSession(terminalSessionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.panels = database.data.panels.filter(
        (panel) => panel.terminalSessionId !== terminalSessionId,
      );
      database.data.panelWorkspaces = database.data.panelWorkspaces.filter(
        (workspace) => workspace.terminalSessionId !== terminalSessionId,
      );
      await database.write();
    });
  }

  async readSessionScrollback(terminalSessionId: string): Promise<string> {
    return this.readScrollbackFile(terminalSessionId);
  }

  async readSessionLiveScrollback(terminalSessionId: string): Promise<string> {
    return this.readLiveScrollbackFile(terminalSessionId);
  }

  async insertSession(session: PersistedTerminalSessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      if (session.scrollback) {
        await this.writeScrollbackFile(session.id, session.scrollback);
      }
      database.data.sessions.push(toMetadataRecord(session));
      await database.write();
    });
  }

  async insertProject(project: PersistedTerminalProjectRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.projects.push(structuredClone(project));
      await database.write();
    });
  }

  async updateProject(params: UpdateTerminalProjectParams): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const project = database.data.projects.find(
        (candidate) => candidate.id === params.projectId,
      );
      if (!project) {
        return;
      }

      if (params.name !== undefined) {
        project.name = params.name;
      }
      if ("path" in params) {
        project.path = params.path ?? null;
      }
      await database.write();
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const childSessionIds = database.data.sessions
        .filter((session) => session.projectId === projectId)
        .map((session) => session.id);
      database.data.projects = database.data.projects.filter(
        (project) => project.id !== projectId,
      );
      database.data.sessions = database.data.sessions.filter(
        (session) => session.projectId !== projectId,
      );
      database.data.panels = database.data.panels.filter(
        (panel) => !childSessionIds.includes(panel.terminalSessionId),
      );
      database.data.panelWorkspaces = database.data.panelWorkspaces.filter(
        (workspace) =>
          !childSessionIds.includes(workspace.terminalSessionId),
      );
      await Promise.all(
        childSessionIds.map((terminalSessionId) =>
          this.deleteScrollbackFile(terminalSessionId),
        ),
      );
      await database.write();
    });
  }

  async setDefaultProject(projectId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      for (const project of database.data.projects) {
        project.isDefault = project.id === projectId;
      }
      await database.write();
    });
  }

  async updateSessionMetadata(
    params: UpdateTerminalSessionMetadataParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.cwd = params.cwd;
      session.activeCommand = params.activeCommand;
      if (params.lastActivityAt !== undefined) {
        session.lastActivityAt = params.lastActivityAt;
      }
      await database.write();
    });
  }

  async updateSessionActivity(
    params: UpdateTerminalSessionActivityParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.lastActivityAt = params.lastActivityAt;
      await database.write();
    });
  }

  async updateSessionLaunch(
    params: UpdateTerminalSessionLaunchParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.command = params.command;
      session.args = [...params.args];
      await database.write();
    });
  }

  async updateSessionAlias(
    params: UpdateTerminalSessionAliasParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.alias = params.alias;
      await database.write();
    });
  }

  async updateSessionThreadId(
    params: UpdateTerminalSessionThreadIdParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      if (params.threadId) {
        session.threadId = params.threadId;
      } else {
        delete session.threadId;
      }
      await database.write();
    });
  }

  async updateSessionPreview(
    params: UpdateTerminalSessionPreviewParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      if (params.preview) {
        session.preview = params.preview;
      } else {
        delete session.preview;
      }
      await database.write();
    });
  }

  async updateSessionLastThread(
    params: UpdateTerminalSessionLastThreadParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }
      session.lastThreadId = params.threadId;
      session.lastThreadStatus = params.status;
      session.lastThreadUpdatedAt = params.updatedAt;
      await database.write();
    });
  }

  async updateSessionRuntimeMetadata(
    params: UpdateTerminalSessionRuntimeMetadataParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.runtimeKind = params.runtimeKind;
      session.tmuxSessionName = params.tmuxSessionName;
      session.tmuxSocketPath = params.tmuxSocketPath;
      session.tmuxUnavailableReason = params.tmuxUnavailableReason;
      session.recoverable = params.recoverable;
      await database.write();
    });
  }

  async updateSessionTerminalState(
    params: UpdateTerminalSessionTerminalStateParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.terminalState = params.terminalState;
      await database.write();
    });
  }

  async updateSessionPanelSplitEnabled(
    params: UpdateTerminalSessionPanelSplitEnabledParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.panelSplitEnabled = params.panelSplitEnabled;
      await database.write();
    });
  }

  async updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void> {
    await this.enqueueScrollbackWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      await this.writeScrollbackFile(
        params.terminalSessionId,
        params.scrollback,
      );
    });
  }

  async appendSessionScrollback(
    params: AppendTerminalSessionScrollbackParams,
  ): Promise<void> {
    if (!params.chunk) {
      return;
    }

    await this.enqueueScrollbackWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      await this.appendScrollbackFile(params.terminalSessionId, params.chunk);
    });
  }

  async updateSessionStatus(
    params: UpdateTerminalSessionStatusParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.status = params.status;
      session.exitCode = params.exitCode;
      if (params.lastActivityAt !== undefined) {
        session.lastActivityAt = params.lastActivityAt;
      }
      await database.write();
    });
  }

  async updateSessionExit(
    params: UpdateTerminalSessionExitParams,
  ): Promise<void> {
    await this.updateSessionStatus(params);
  }

  async reorderProjects(orderedIds: string[]): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      for (const project of database.data.projects) {
        const index = orderedIds.indexOf(project.id);
        project.order = index >= 0 ? index : project.order;
      }
      await database.write();
    });
  }

  async reorderSessions(
    projectId: string,
    orderedIds: string[],
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      for (const session of database.data.sessions) {
        if (session.projectId !== projectId) {
          continue;
        }
        const index = orderedIds.indexOf(session.id);
        session.order = index >= 0 ? index : session.order;
      }
      await database.write();
    });
  }

  async deleteSession(terminalSessionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.sessions = database.data.sessions.filter(
        (session) => session.id !== terminalSessionId,
      );
      database.data.panels = database.data.panels.filter(
        (panel) => panel.terminalSessionId !== terminalSessionId,
      );
      database.data.panelWorkspaces = database.data.panelWorkspaces.filter(
        (workspace) => workspace.terminalSessionId !== terminalSessionId,
      );
      await database.write();
    });
    await this.enqueueScrollbackWrite(async () => {
      await this.deleteScrollbackFile(terminalSessionId);
    });
  }

  private getDatabase(): Low<TerminalSessionStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] terminal session store not initialized");
    }

    return this.database;
  }

  private getSessionMetadataRecords(): PersistedTerminalSessionMetadataRecord[] {
    return this.getDatabase()
      .data.sessions.slice()
      .sort((left, right) => {
        const leftOrder = left.order;
        const rightOrder = right.order;
        if (leftOrder !== undefined && rightOrder !== undefined) {
          return leftOrder - rightOrder;
        }
        if (leftOrder !== undefined) return -1;
        if (rightOrder !== undefined) return 1;
        return left.createdAt.localeCompare(right.createdAt);
      })
      .map((session) => structuredClone(session));
  }

  private async getSessions(): Promise<PersistedTerminalSessionRecord[]> {
    const sessions = this.getSessionMetadataRecords();
    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        scrollback: await this.readSessionScrollback(session.id),
      })),
    );
  }

  private getPanels(): PersistedTerminalPanelRecord[] {
    return (this.getDatabase().data.panels ?? [])
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((panel) => structuredClone(panel));
  }

  private getPanelWorkspaces(): PersistedTerminalPanelWorkspaceRecord[] {
    return (this.getDatabase().data.panelWorkspaces ?? []).map((workspace) =>
      structuredClone(workspace),
    );
  }

  private getProjects(): PersistedTerminalProjectRecord[] {
    return this.getDatabase()
      .data.projects.slice()
      .sort((left, right) => {
        const leftOrder = left.order;
        const rightOrder = right.order;
        if (leftOrder !== undefined && rightOrder !== undefined) {
          return leftOrder - rightOrder;
        }
        if (leftOrder !== undefined) return -1;
        if (rightOrder !== undefined) return 1;
        return left.createdAt.localeCompare(right.createdAt);
      })
      .map((project) => structuredClone(project));
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run;
    return run;
  }

  private enqueueScrollbackWrite(
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.pendingScrollbackWrite
      .catch(() => undefined)
      .then(operation);
    this.pendingScrollbackWrite = run;
    return run;
  }

  private resolveScrollbackFile(terminalSessionId: string): string {
    return path.join(
      this.scrollbackDir,
      `${encodeURIComponent(terminalSessionId)}.log`,
    );
  }

  private async readScrollbackFile(terminalSessionId: string): Promise<string> {
    try {
      return await readFile(
        this.resolveScrollbackFile(terminalSessionId),
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  private async readLiveScrollbackFile(
    terminalSessionId: string,
  ): Promise<string> {
    const scrollbackFile = this.resolveScrollbackFile(terminalSessionId);
    try {
      const stats = await stat(scrollbackFile);
      if (stats.size <= 0) {
        return "";
      }

      const bytesToRead = Math.min(stats.size, LIVE_SCROLLBACK_READ_BYTES);
      const file = await open(scrollbackFile, "r");
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await file.read(
          buffer,
          0,
          bytesToRead,
          stats.size - bytesToRead,
        );
        let tail = buffer.toString("utf8", 0, bytesRead);
        if (stats.size > bytesToRead) {
          const firstLineBreak = tail.indexOf("\n");
          if (firstLineBreak >= 0 && firstLineBreak < tail.length - 1) {
            tail = tail.slice(firstLineBreak + 1);
          }
        }
        return getLiveTerminalScrollback(tail);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  private async writeScrollbackFile(
    terminalSessionId: string,
    scrollback: string,
  ): Promise<void> {
    await mkdir(this.scrollbackDir, { recursive: true });
    await writeFile(
      this.resolveScrollbackFile(terminalSessionId),
      scrollback,
      "utf8",
    );
  }

  private async appendScrollbackFile(
    terminalSessionId: string,
    chunk: string,
  ): Promise<void> {
    await mkdir(this.scrollbackDir, { recursive: true });
    const scrollbackFile = this.resolveScrollbackFile(terminalSessionId);
    await appendFile(scrollbackFile, chunk, "utf8");

    const stats = await stat(scrollbackFile);
    if (stats.size <= TERMINAL_PERSISTED_SCROLLBACK_BYTES) {
      return;
    }

    const oversizedScrollback = await readFile(scrollbackFile, "utf8");
    const compactedScrollback = readScrollbackBuffer(
      createScrollbackBuffer(
        oversizedScrollback,
        TERMINAL_COMPACTED_SCROLLBACK_BYTES,
      ),
    );
    await writeFile(scrollbackFile, compactedScrollback, "utf8");
  }

  private async deleteScrollbackFile(terminalSessionId: string): Promise<void> {
    await rm(this.resolveScrollbackFile(terminalSessionId), { force: true });
  }
}

function toMetadataRecord(
  session: PersistedTerminalSessionRecord,
): PersistedTerminalSessionMetadataRecord {
  return {
    id: session.id,
    projectId: session.projectId,
    alias: session.alias ?? null,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    activeCommand: session.activeCommand ?? null,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.order !== undefined ? { order: session.order } : {}),
    ...(session.lastActivityAt !== undefined
      ? { lastActivityAt: session.lastActivityAt }
      : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.runtimeKind !== undefined
      ? { runtimeKind: session.runtimeKind }
      : {}),
    ...(session.tmuxSessionName !== undefined
      ? { tmuxSessionName: session.tmuxSessionName }
      : {}),
    ...(session.tmuxSocketPath !== undefined
      ? { tmuxSocketPath: session.tmuxSocketPath }
      : {}),
    ...(session.tmuxUnavailableReason !== undefined
      ? { tmuxUnavailableReason: session.tmuxUnavailableReason }
      : {}),
    ...(session.recoverable !== undefined
      ? { recoverable: session.recoverable }
      : {}),
    ...(session.terminalState !== undefined
      ? { terminalState: session.terminalState }
      : {}),
  };
}

const LEGACY_COMMAND_SUFFIXES = new Set([
  "bash",
  "bun",
  "codex",
  "coco",
  "deno",
  "fish",
  "git",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "sh",
  "vim",
  "zsh",
]);
const INTERACTIVE_SHELL_SUFFIXES = new Set(["bash", "fish", "sh", "zsh"]);
const LEGACY_UNDERSCORE_NAME_RE = /^(.+)_([A-Za-z][A-Za-z0-9.-]*)$/;
const LEGACY_WRAPPED_COMMAND_RE =
  /^(.+)_([A-Za-z][A-Za-z0-9.-]*)\((node|bun)\)$/;

function buildDirectoryLabel(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "") || cwd;
  const baseName = path.basename(normalized);
  return baseName || normalized || "/";
}

function basename(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? value
  );
}

function normalizeLegacyCommand(command: string | undefined): string | null {
  if (!command || !LEGACY_COMMAND_SUFFIXES.has(command)) {
    return null;
  }
  return INTERACTIVE_SHELL_SUFFIXES.has(command) ? null : command;
}

function normalizeActiveCommand(params: {
  activeCommand?: string | null;
  command: string;
  cwd: string;
  legacyName?: string;
}): string | null {
  const activeCommand = params.activeCommand?.trim();
  if (activeCommand) {
    return activeCommand;
  }

  const legacyName = params.legacyName?.trim();
  if (!legacyName) {
    return null;
  }

  if (
    legacyName === params.command ||
    legacyName === basename(params.command)
  ) {
    return null;
  }

  const directoryLabel = buildDirectoryLabel(params.cwd);
  if (legacyName === directoryLabel) {
    return null;
  }

  if (legacyName.startsWith(`${directoryLabel}(`) && legacyName.endsWith(")")) {
    return normalizeLegacyCommand(
      legacyName.slice(directoryLabel.length + 1, -1),
    );
  }

  const wrappedMatch = LEGACY_WRAPPED_COMMAND_RE.exec(legacyName);
  if (wrappedMatch?.[1] === directoryLabel) {
    return normalizeLegacyCommand(wrappedMatch[2]);
  }

  const underscoreMatch = LEGACY_UNDERSCORE_NAME_RE.exec(legacyName);
  if (underscoreMatch?.[1] === directoryLabel) {
    return normalizeLegacyCommand(underscoreMatch[2]);
  }

  return null;
}
