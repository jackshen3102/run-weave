import type { TerminalSessionMetadataSnapshot } from "@runweave/shared/terminal/events";
import type { TerminalSessionStore } from "./store";
import {
  buildPanelRecord,
  buildPanelWorkspaceRecord,
  buildProjectRecord,
  buildSessionRecord,
  createRuntimeRecord,
  type RuntimeTerminalSessionRecord,
  type TerminalPanelRecord,
  type TerminalPanelWorkspaceRecord,
  type TerminalProjectRecord,
  type TerminalSessionRecord,
} from "./manager-records";
import { sortTerminalProjects, sortTerminalSessions } from "./manager-ordering";
import type { LastAiActiveCommandRecord } from "./completion-source-gate";

export interface TerminalSessionManagerObserver {
  onBell?: (input: {
    terminalSessionId: string;
    projectId: string;
    count: number;
  }) => void;
  onMetadataChanged?: (input: {
    terminalSessionId: string;
    projectId: string;
    session: TerminalSessionRecord;
    previous: TerminalSessionMetadataSnapshot;
    next: TerminalSessionMetadataSnapshot;
  }) => void;
}

export abstract class TerminalManagerBase {
  protected readonly projects = new Map<string, TerminalProjectRecord>();
  protected readonly sessions = new Map<string, RuntimeTerminalSessionRecord>();
  protected readonly panels = new Map<string, TerminalPanelRecord>();
  protected readonly panelWorkspaces = new Map<
    string,
    TerminalPanelWorkspaceRecord
  >();
  protected readonly lastAiActiveCommands = new Map<
    string,
    LastAiActiveCommandRecord
  >();
  protected readonly scrollbackFlushTimers = new Map<string, NodeJS.Timeout>();
  protected readonly pendingScrollbackChunks = new Map<string, string[]>();
  protected readonly activityFlushTimers = new Map<string, NodeJS.Timeout>();
  protected readonly pendingActivityUpdates = new Map<string, Date>();

  constructor(
    protected readonly sessionStore: TerminalSessionStore,
    protected readonly observer: TerminalSessionManagerObserver = {},
  ) {}

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
}
