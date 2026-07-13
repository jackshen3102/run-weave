import type { TerminalLastThreadStatus } from "@runweave/shared/terminal/session";
import type { TerminalAgentKind, TerminalState } from "@runweave/shared/terminal/state";
import {
  toPersistedPanel,
  toPersistedPanelWorkspace,
  type TerminalPanelRecord,
  type TerminalPanelWorkspaceRecord,
} from "./manager-records";
import { TerminalManagerSessionRuntime } from "./manager-session-runtime";

export class TerminalManagerPanelOperations extends TerminalManagerSessionRuntime {
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
        : (nextPanelIds[0] ?? "");
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
    provider: TerminalAgentKind | null = null,
  ): Promise<TerminalPanelRecord | undefined> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      return undefined;
    }

    const nextThreadId = threadId?.trim() || undefined;
    const nextProvider = nextThreadId
      ? provider ?? panel.threadProvider ??
        (panel.threadId === nextThreadId ? "codex" : undefined)
      : undefined;
    if (
      panel.threadId === nextThreadId && panel.threadProvider === nextProvider
    ) {
      return panel;
    }

    if (nextThreadId) {
      panel.threadId = nextThreadId;
      panel.threadProvider = nextProvider;
    } else {
      delete panel.threadId;
      delete panel.threadProvider;
    }
    await this.sessionStore.updatePanelThreadId({
      panelId,
      threadId: nextThreadId ?? null,
      provider: nextProvider ?? null,
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

  async updatePanelLastThread(
    panelId: string,
    threadId: string,
    status: TerminalLastThreadStatus,
    updatedAt = new Date(),
    provider?: TerminalAgentKind,
  ): Promise<TerminalPanelRecord | undefined> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      return undefined;
    }

    const nextThreadId = threadId.trim();
    if (!nextThreadId) {
      return panel;
    }

    const nextProvider =
      provider ?? panel.threadProvider ??
      (panel.threadId === nextThreadId ? "codex" : undefined);
    if (!nextProvider) {
      return panel;
    }

    if (
      panel.lastThreadId === nextThreadId &&
      panel.lastThreadProvider === nextProvider &&
      panel.lastThreadStatus === status &&
      panel.lastThreadUpdatedAt?.getTime() === updatedAt.getTime()
    ) {
      return panel;
    }

    panel.lastThreadId = nextThreadId;
    panel.lastThreadProvider = nextProvider;
    panel.lastThreadStatus = status;
    panel.lastThreadUpdatedAt = updatedAt;
    await this.sessionStore.updatePanelLastThread({
      panelId,
      threadId: nextThreadId,
      provider: nextProvider,
      status,
      updatedAt: updatedAt.toISOString(),
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
}
