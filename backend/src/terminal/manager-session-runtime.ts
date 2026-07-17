import type { TerminalLastThreadStatus } from "@runweave/shared/terminal/session";
import type {
  TerminalAgentKind,
  TerminalState,
} from "@runweave/shared/terminal/state";
import type { TerminalRuntimeMetadata } from "./store";
import type {
  RuntimeTerminalSessionRecord,
  TerminalSessionRecord,
} from "./manager-records";
import { isExistingDirectory } from "./manager-path";
import { getAgentForCommand } from "./terminal-state-service";
import { TerminalManagerAgentActivityRuntime } from "./manager-agent-activity-runtime";

export class TerminalManagerSessionRuntime extends TerminalManagerAgentActivityRuntime {
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

    const previous = {
      cwd: session.cwd,
      activeCommand: session.activeCommand,
    };

    if (runningPanelCount === 0) {
      await this.observeActiveCommand(
        terminalSessionId,
        session.activeCommand,
        nextActiveCommand,
      );
    }
    session.cwd = metadata.cwd;
    session.activeCommand = nextActiveCommand;
    const storedThreadProvider =
      session.threadProvider ?? (session.threadId ? "codex" : undefined);
    const shouldClearAgentThreadMetadata =
      Boolean(session.threadId || session.preview) &&
      getAgentForCommand(nextActiveCommand) !== storedThreadProvider;
    const clearedThreadId = shouldClearAgentThreadMetadata
      ? session.threadId
      : undefined;
    if (shouldClearAgentThreadMetadata) {
      this.clearAgentThreadMetadata(session);
    }
    const lastActivityAt = this.touchSessionActivity(session, "immediate");
    await this.sessionStore.updateSessionMetadata({
      terminalSessionId,
      cwd: metadata.cwd,
      activeCommand: nextActiveCommand,
      lastActivityAt: lastActivityAt.toISOString(),
    });
    if (shouldClearAgentThreadMetadata) {
      if (clearedThreadId) {
        await this.updateSessionLastThread(
          terminalSessionId,
          clearedThreadId,
          "idle",
          new Date(),
          storedThreadProvider,
        );
      }
      await this.persistClearedAgentThreadMetadata(terminalSessionId);
    }
    this.observer.onMetadataChanged?.({
      terminalSessionId,
      projectId: session.projectId,
      session,
      previous,
      next: {
        cwd: session.cwd,
        activeCommand: session.activeCommand,
      },
    });
    return session;
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
    const storedThreadProvider =
      session.threadProvider ?? (session.threadId ? "codex" : undefined);
    const shouldClearAgentThreadMetadata =
      Boolean(session.threadId || session.preview) &&
      getAgentForCommand(launch.command) !== storedThreadProvider;
    const clearedThreadId = shouldClearAgentThreadMetadata
      ? session.threadId
      : undefined;
    if (shouldClearAgentThreadMetadata) {
      this.clearAgentThreadMetadata(session);
    }
    await this.sessionStore.updateSessionLaunch({
      terminalSessionId,
      command: launch.command,
      args: nextArgs,
    });
    if (shouldClearAgentThreadMetadata) {
      if (clearedThreadId) {
        await this.updateSessionLastThread(
          terminalSessionId,
          clearedThreadId,
          "idle",
          new Date(),
          storedThreadProvider,
        );
      }
      await this.persistClearedAgentThreadMetadata(terminalSessionId);
    }
    return session;
  }

  private clearAgentThreadMetadata(
    session: RuntimeTerminalSessionRecord,
  ): void {
    delete session.threadId;
    delete session.threadProvider;
    delete session.preview;
  }

  private async persistClearedAgentThreadMetadata(
    terminalSessionId: string,
  ): Promise<void> {
    await this.sessionStore.updateSessionThreadId({
      terminalSessionId,
      threadId: null,
      provider: null,
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
    provider: TerminalAgentKind | null = null,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const nextThreadId = threadId?.trim() || undefined;
    const nextProvider = nextThreadId
      ? (provider ??
        session.threadProvider ??
        (session.threadId === nextThreadId ? "codex" : undefined))
      : undefined;
    if (
      session.threadId === nextThreadId &&
      session.threadProvider === nextProvider
    ) {
      return session;
    }

    if (nextThreadId) {
      session.threadId = nextThreadId;
      session.threadProvider = nextProvider;
    } else {
      delete session.threadId;
      delete session.threadProvider;
    }
    await this.sessionStore.updateSessionThreadId({
      terminalSessionId,
      threadId: nextThreadId ?? null,
      provider: nextProvider ?? null,
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

  async updateSessionLastThread(
    terminalSessionId: string,
    threadId: string,
    status: TerminalLastThreadStatus,
    updatedAt = new Date(),
    provider?: TerminalAgentKind,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const nextThreadId = threadId.trim();
    if (!nextThreadId) {
      return session;
    }

    const nextProvider =
      provider ??
      session.threadProvider ??
      (session.threadId === nextThreadId ? "codex" : undefined);
    if (!nextProvider) {
      return session;
    }

    if (
      session.lastThreadId === nextThreadId &&
      session.lastThreadProvider === nextProvider &&
      session.lastThreadStatus === status &&
      session.lastThreadUpdatedAt?.getTime() === updatedAt.getTime()
    ) {
      return session;
    }

    session.lastThreadId = nextThreadId;
    session.lastThreadProvider = nextProvider;
    session.lastThreadStatus = status;
    session.lastThreadUpdatedAt = updatedAt;
    await this.sessionStore.updateSessionLastThread({
      terminalSessionId,
      threadId: nextThreadId,
      provider: nextProvider,
      status,
      updatedAt: updatedAt.toISOString(),
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

  async recordSessionCompletion(
    terminalSessionId: string,
  ): Promise<number | null> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return null;
    }

    const completionRevision = session.completionRevision + 1;
    session.completionRevision = completionRevision;
    await this.sessionStore.updateSessionCompletion({
      terminalSessionId,
      completionRevision,
      acknowledgedCompletionRevision: session.acknowledgedCompletionRevision,
    });
    return completionRevision;
  }

  async acknowledgeSessionCompletion(
    terminalSessionId: string,
    completionRevision: number,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return undefined;
    }

    const acknowledgedCompletionRevision = Math.min(
      completionRevision,
      session.completionRevision,
    );
    if (
      acknowledgedCompletionRevision <= session.acknowledgedCompletionRevision
    ) {
      return session;
    }

    session.acknowledgedCompletionRevision = acknowledgedCompletionRevision;
    await this.sessionStore.updateSessionCompletion({
      terminalSessionId,
      completionRevision: session.completionRevision,
      acknowledgedCompletionRevision,
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
    this.clearRecentAgentActivitiesForSession(terminalSessionId);
    this.clearPanelAgentOperationState(terminalSessionId);
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
}
