import type { TerminalSessionMetadataSnapshot } from "@runweave/shared/terminal/events";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
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

export type TerminalPanelMutationListener = (
  panel: TerminalPanelRecord,
  context?: { operationId?: string | null },
) => void;

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
  private readonly panelMutationListeners = new Map<
    string,
    Set<TerminalPanelMutationListener>
  >();
  private readonly panelAgentPreparations = new Map<
    string,
    {
      operationId: string;
      provider: TerminalAgentKind;
      previousGeneration?: {
        operationId: string;
        provider: TerminalAgentKind;
      };
    }
  >();
  private readonly panelAgentOperationGenerations = new Map<
    string,
    { operationId: string; provider: TerminalAgentKind }
  >();

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

  subscribePanelMutations(
    panelId: string,
    listener: TerminalPanelMutationListener,
  ): () => void {
    const listeners = this.panelMutationListeners.get(panelId) ?? new Set();
    listeners.add(listener);
    this.panelMutationListeners.set(panelId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.panelMutationListeners.delete(panelId);
      }
    };
  }

  beginPanelAgentPreparation(
    terminalSessionId: string,
    panelId: string,
    operationId: string,
    provider: TerminalAgentKind,
  ): boolean {
    const key = `${terminalSessionId}\u0000${panelId}`;
    if (this.panelAgentPreparations.has(key)) {
      return false;
    }
    const identity = { operationId, provider };
    const previousGeneration = this.panelAgentOperationGenerations.get(key);
    this.panelAgentPreparations.set(key, {
      ...identity,
      previousGeneration,
    });
    this.panelAgentOperationGenerations.set(key, identity);
    return true;
  }

  endPanelAgentPreparation(
    terminalSessionId: string,
    panelId: string,
    operationId: string,
  ): void {
    const key = `${terminalSessionId}\u0000${panelId}`;
    const preparation = this.panelAgentPreparations.get(key);
    if (preparation?.operationId !== operationId) {
      return;
    }
    this.panelAgentPreparations.delete(key);
    if (
      this.panelAgentOperationGenerations.get(key)?.operationId === operationId
    ) {
      if (preparation.previousGeneration) {
        this.panelAgentOperationGenerations.set(
          key,
          preparation.previousGeneration,
        );
      } else {
        this.panelAgentOperationGenerations.delete(key);
      }
    }
  }

  releasePanelAgentPreparation(
    terminalSessionId: string,
    panelId: string,
    operationId: string,
  ): void {
    const key = `${terminalSessionId}\u0000${panelId}`;
    if (this.panelAgentPreparations.get(key)?.operationId === operationId) {
      this.panelAgentPreparations.delete(key);
    }
  }

  matchesPanelAgentOperationGeneration(
    terminalSessionId: string,
    panelId: string,
    operationId: string,
    provider: TerminalAgentKind,
  ): boolean {
    const active = this.panelAgentOperationGenerations.get(
      `${terminalSessionId}\u0000${panelId}`,
    );
    if (!active || active.operationId !== operationId) {
      return false;
    }
    if (active.provider === "codex") {
      return provider === "codex";
    }
    return (
      provider === "trae" || provider === "traex" || provider === "traecli"
    );
  }

  hasPanelAgentPreparation(
    terminalSessionId: string,
    panelId: string,
  ): boolean {
    return this.panelAgentPreparations.has(
      `${terminalSessionId}\u0000${panelId}`,
    );
  }

  hasPanelAgentOperationGeneration(
    terminalSessionId: string,
    panelId: string,
  ): boolean {
    return this.panelAgentOperationGenerations.has(
      `${terminalSessionId}\u0000${panelId}`,
    );
  }

  hasSessionAgentPreparation(terminalSessionId: string): boolean {
    const prefix = `${terminalSessionId}\u0000`;
    return Array.from(this.panelAgentPreparations.keys()).some((key) =>
      key.startsWith(prefix),
    );
  }

  protected clearPanelAgentOperationState(
    terminalSessionId: string,
  ): void {
    const prefix = `${terminalSessionId}\u0000`;
    for (const key of this.panelAgentPreparations.keys()) {
      if (key.startsWith(prefix)) {
        this.panelAgentPreparations.delete(key);
      }
    }
    for (const key of this.panelAgentOperationGenerations.keys()) {
      if (key.startsWith(prefix)) {
        this.panelAgentOperationGenerations.delete(key);
      }
    }
  }

  protected notifyPanelMutation(
    panel: TerminalPanelRecord,
    context?: { operationId?: string | null },
  ): void {
    for (const listener of this.panelMutationListeners.get(panel.id) ?? []) {
      listener(panel, context);
    }
  }

  getPanelWorkspace(
    terminalSessionId: string,
  ): TerminalPanelWorkspaceRecord | undefined {
    return this.panelWorkspaces.get(terminalSessionId);
  }
}
