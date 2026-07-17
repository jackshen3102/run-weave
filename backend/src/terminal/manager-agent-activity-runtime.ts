import {
  buildRecentAgentActivityKey,
  getCompletionSourceForCommand,
  isCompletionSourceAllowedForCommand,
  type RecentAgentActivityRecord,
} from "./completion-source-gate";
import { TerminalManagerBufferRuntime } from "./manager-buffer-runtime";

export class TerminalManagerAgentActivityRuntime extends TerminalManagerBufferRuntime {
  getRecentAgentActivity(
    terminalSessionId: string,
    panelId: string | null,
  ): RecentAgentActivityRecord | null {
    return (
      this.recentAgentActivities.get(
        buildRecentAgentActivityKey(terminalSessionId, panelId),
      ) ?? null
    );
  }

  async observePanelActiveCommand(
    terminalSessionId: string,
    panelId: string,
    previousActiveCommand: string | null,
    activeCommand: string | null,
  ): Promise<void> {
    this.recentAgentActivities.delete(
      buildRecentAgentActivityKey(terminalSessionId, null),
    );
    await this.sessionStore.deleteRecentAgentActivity(terminalSessionId, null);
    await this.observeActiveCommand(
      terminalSessionId,
      previousActiveCommand,
      activeCommand,
      panelId,
    );
  }

  async clearRecentAgentActivity(
    terminalSessionId: string,
    panelId: string | null,
  ): Promise<void> {
    this.recentAgentActivities.delete(
      buildRecentAgentActivityKey(terminalSessionId, panelId),
    );
    await this.sessionStore.deleteRecentAgentActivity(
      terminalSessionId,
      panelId,
    );
  }

  protected clearRecentAgentActivitiesForSession(
    terminalSessionId: string,
  ): void {
    for (const [key, activity] of this.recentAgentActivities) {
      if (activity.terminalSessionId === terminalSessionId) {
        this.recentAgentActivities.delete(key);
      }
    }
  }

  protected async observeActiveCommand(
    terminalSessionId: string,
    previousActiveCommand: string | null,
    activeCommand: string | null,
    panelId: string | null = null,
  ): Promise<void> {
    const now = Date.now();
    const key = buildRecentAgentActivityKey(terminalSessionId, panelId);
    const source = getCompletionSourceForCommand(activeCommand);
    if (source && activeCommand) {
      const previous = this.recentAgentActivities.get(key);
      let generation = panelId
        ? this.getPanelAgentOperationGeneration(terminalSessionId, panelId)
        : null;
      if (
        panelId &&
        previous?.phase === "grace" &&
        previous.operationId &&
        generation?.operationId === previous.operationId
      ) {
        this.clearPanelAgentOperationGeneration(terminalSessionId, panelId);
        generation = null;
      }
      const operationId =
        generation &&
        isCompletionSourceAllowedForCommand(source, generation.provider)
          ? generation.operationId
          : null;
      if (
        previous?.phase === "active" &&
        previous.command === activeCommand &&
        previous.source === source &&
        previous.operationId === operationId
      ) {
        return;
      }
      this.recentAgentActivities.set(key, {
        terminalSessionId,
        panelId,
        command: activeCommand,
        source,
        operationId,
        phase: "active",
        observedAt: now,
        clearedAt: null,
      });
      await this.sessionStore.upsertRecentAgentActivity(
        this.recentAgentActivities.get(key)!,
      );
      return;
    }

    if (activeCommand !== null) {
      this.recentAgentActivities.delete(key);
      if (panelId) {
        this.clearPanelAgentOperationGeneration(terminalSessionId, panelId);
      }
      await this.sessionStore.deleteRecentAgentActivity(
        terminalSessionId,
        panelId,
      );
      return;
    }

    const previous = this.recentAgentActivities.get(key);
    const previousSource = getCompletionSourceForCommand(previousActiveCommand);
    if (!previousSource || !previousActiveCommand) {
      return;
    }
    const generation = panelId
      ? this.getPanelAgentOperationGeneration(terminalSessionId, panelId)
      : null;
    const operationId =
      previous?.source === previousSource &&
      previous.command === previousActiveCommand
        ? previous.operationId
        : generation &&
            isCompletionSourceAllowedForCommand(
              previousSource,
              generation.provider,
            )
          ? generation.operationId
          : null;
    this.recentAgentActivities.set(key, {
      terminalSessionId,
      panelId,
      command: previousActiveCommand,
      source: previousSource,
      operationId,
      phase: "grace",
      observedAt:
        previous?.source === previousSource &&
        previous.command === previousActiveCommand
          ? previous.observedAt
          : now,
      clearedAt: now,
    });
    await this.sessionStore.upsertRecentAgentActivity(
      this.recentAgentActivities.get(key)!,
    );
  }
}
