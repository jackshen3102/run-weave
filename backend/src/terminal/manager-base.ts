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
import {
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
  AGENT_ACTIVITY_STARTING_MAX_AGE_MS,
  buildRecentAgentActivityKey,
  isCompletionSourceAllowedForCommand,
  type RecentAgentActivityRecord,
} from "./completion-source-gate";

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
  protected readonly recentAgentActivities = new Map<
    string,
    RecentAgentActivityRecord
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
      previousActivity?: RecentAgentActivityRecord;
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
    const persistedRecentAgentActivities =
      await this.sessionStore.listRecentAgentActivities();

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
    const now = Date.now();
    const invalidActivities: RecentAgentActivityRecord[] = [];
    for (const activity of persistedRecentAgentActivities) {
      const session = this.sessions.get(activity.terminalSessionId);
      const panel = activity.panelId
        ? this.panels.get(activity.panelId)
        : null;
      const targetActiveCommand = panel
        ? panel.activeCommand
        : session?.activeCommand ?? null;
      const targetExists = Boolean(
        session &&
          (!activity.panelId ||
            (panel?.terminalSessionId === activity.terminalSessionId &&
              panel.status === "running")),
      );
      const activeMatches =
        activity.phase === "active" &&
        isCompletionSourceAllowedForCommand(
          activity.source,
          targetActiveCommand,
        );
      const startingMatches =
        activity.phase === "starting" &&
        activity.operationId !== null &&
        Number.isFinite(activity.observedAt) &&
        now - activity.observedAt >= 0 &&
        now - activity.observedAt <= AGENT_ACTIVITY_STARTING_MAX_AGE_MS;
      const graceMatches =
        activity.phase === "grace" &&
        targetActiveCommand === null &&
        activity.clearedAt !== null &&
        Number.isFinite(activity.clearedAt) &&
        now - activity.clearedAt >= 0 &&
        now - activity.clearedAt <=
          AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;
      if (
        !targetExists ||
        !isTerminalAgentKind(activity.source) ||
        !Number.isFinite(activity.observedAt) ||
        (!startingMatches && !activeMatches && !graceMatches)
      ) {
        invalidActivities.push(activity);
        continue;
      }
      this.recentAgentActivities.set(
        buildRecentAgentActivityKey(
          activity.terminalSessionId,
          activity.panelId,
        ),
        activity,
      );
      if (panel && activity.operationId) {
        this.panelAgentOperationGenerations.set(
          `${activity.terminalSessionId}\u0000${panel.id}`,
          {
            operationId: activity.operationId,
            provider: activity.source,
          },
        );
      }
    }
    await Promise.all(
      invalidActivities.map((activity) =>
        this.sessionStore.deleteRecentAgentActivity(
          activity.terminalSessionId,
          activity.panelId,
        ),
      ),
    );
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

  async beginPanelAgentPreparation(
    terminalSessionId: string,
    panelId: string,
    operationId: string,
    provider: TerminalAgentKind,
  ): Promise<boolean> {
    const key = `${terminalSessionId}\u0000${panelId}`;
    if (this.panelAgentPreparations.has(key)) {
      return false;
    }
    const identity = { operationId, provider };
    const previousGeneration = this.panelAgentOperationGenerations.get(key);
    const activityKey = buildRecentAgentActivityKey(
      terminalSessionId,
      panelId,
    );
    const previousActivity = this.recentAgentActivities.get(activityKey);
    this.panelAgentPreparations.set(key, {
      ...identity,
      previousGeneration,
      previousActivity,
    });
    this.panelAgentOperationGenerations.set(key, identity);
    const activity: RecentAgentActivityRecord = {
      terminalSessionId,
      panelId,
      command: provider,
      source: provider,
      operationId,
      phase: "starting",
      observedAt: Date.now(),
      clearedAt: null,
    };
    this.recentAgentActivities.delete(
      buildRecentAgentActivityKey(terminalSessionId, null),
    );
    this.recentAgentActivities.set(activityKey, activity);
    try {
      await this.sessionStore.deleteRecentAgentActivity(
        terminalSessionId,
        null,
      );
      await this.sessionStore.upsertRecentAgentActivity(activity);
    } catch (error) {
      this.panelAgentPreparations.delete(key);
      if (previousGeneration) {
        this.panelAgentOperationGenerations.set(key, previousGeneration);
      } else {
        this.panelAgentOperationGenerations.delete(key);
      }
      if (previousActivity) {
        this.recentAgentActivities.set(activityKey, previousActivity);
      } else {
        this.recentAgentActivities.delete(activityKey);
      }
      throw error;
    }
    return true;
  }

  async endPanelAgentPreparation(
    terminalSessionId: string,
    panelId: string,
    operationId: string,
  ): Promise<void> {
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
    const activityKey = buildRecentAgentActivityKey(
      terminalSessionId,
      panelId,
    );
    if (preparation.previousActivity) {
      this.recentAgentActivities.set(
        activityKey,
        preparation.previousActivity,
      );
      await this.sessionStore.upsertRecentAgentActivity(
        preparation.previousActivity,
      );
    } else {
      this.recentAgentActivities.delete(activityKey);
      await this.sessionStore.deleteRecentAgentActivity(
        terminalSessionId,
        panelId,
      );
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

  getPanelAgentOperationGeneration(
    terminalSessionId: string,
    panelId: string,
  ): { operationId: string; provider: TerminalAgentKind } | null {
    return (
      this.panelAgentOperationGenerations.get(
        `${terminalSessionId}\u0000${panelId}`,
      ) ?? null
    );
  }

  clearPanelAgentOperationGeneration(
    terminalSessionId: string,
    panelId: string,
  ): void {
    const key = `${terminalSessionId}\u0000${panelId}`;
    this.panelAgentPreparations.delete(key);
    this.panelAgentOperationGenerations.delete(key);
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

function isTerminalAgentKind(value: string): value is TerminalAgentKind {
  return (
    value === "codex" ||
    value === "trae" ||
    value === "traecli" ||
    value === "traex"
  );
}
