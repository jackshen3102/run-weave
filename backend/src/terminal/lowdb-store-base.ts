import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  PersistedTerminalPanelRecord,
  PersistedTerminalPanelWorkspaceRecord,
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionMetadataRecord,
  PersistedTerminalSessionRecord,
} from "./store";
import { normalizeActiveCommand } from "./lowdb-records";

export interface TerminalSessionStoreData {
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

export abstract class LowDbStoreBase {
  protected database: Low<TerminalSessionStoreData> | null = null;
  protected pendingWrite: Promise<void> = Promise.resolve();
  protected pendingScrollbackWrite: Promise<void> = Promise.resolve();
  protected readonly scrollbackDir: string;

  constructor(protected readonly storeFile: string) {
    this.scrollbackDir = path.join(
      path.dirname(storeFile),
      "terminal-scrollback",
    );
  }

  abstract readSessionScrollback(terminalSessionId: string): Promise<string>;

  protected abstract writeScrollbackFile(
    terminalSessionId: string,
    scrollback: string,
  ): Promise<void>;

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

  protected getDatabase(): Low<TerminalSessionStoreData> {
    if (!this.database) {
      throw new Error("[viewer-be] terminal session store not initialized");
    }

    return this.database;
  }

  protected getSessionMetadataRecords(): PersistedTerminalSessionMetadataRecord[] {
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

  protected async getSessions(): Promise<PersistedTerminalSessionRecord[]> {
    const sessions = this.getSessionMetadataRecords();
    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        scrollback: await this.readSessionScrollback(session.id),
      })),
    );
  }

  protected getPanels(): PersistedTerminalPanelRecord[] {
    return (this.getDatabase().data.panels ?? [])
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((panel) => structuredClone(panel));
  }

  protected getPanelWorkspaces(): PersistedTerminalPanelWorkspaceRecord[] {
    return (this.getDatabase().data.panelWorkspaces ?? []).map((workspace) =>
      structuredClone(workspace),
    );
  }

  protected getProjects(): PersistedTerminalProjectRecord[] {
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

  protected enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.catch(() => undefined).then(operation);
    this.pendingWrite = run;
    return run;
  }

  protected enqueueScrollbackWrite(
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.pendingScrollbackWrite
      .catch(() => undefined)
      .then(operation);
    this.pendingScrollbackWrite = run;
    return run;
  }
}
