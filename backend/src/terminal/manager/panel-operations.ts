import { invalidateTerminalInput } from "../runtime/input-admission";
import { forceClearCodexContext } from "../runtime/codex-context";
import type { TerminalLastThreadStatus } from "@runweave/shared/terminal/session";
import type { TerminalAgentKind, TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalProgramStatus } from "@runweave/shared/terminal/program-status";
import {
  toPersistedPanel,
  toPersistedPanelWorkspace,
  type TerminalPanelRecord,
  type TerminalPanelWorkspaceRecord,
} from "./records";
import { TerminalManagerSessionRuntime } from "./session-runtime";
import type { TerminalReplySnapshot } from "../store/store";

export class TerminalManagerPanelOperations extends TerminalManagerSessionRuntime {
  setPanelProgramStatus(panelId: string, status?: Pick<TerminalProgramStatus, "state" | "kind">): void {
    const panel = this.panels.get(panelId);
    const session = panel && this.getSession(panel.terminalSessionId);
    if (!panel || !session || panel.status !== "running" || session.status !== "running") return;
    const previous = panel.oscProgramStatus;
    if (previous?.state === status?.state && previous?.kind === status?.kind) return;
    if (status) {
      panel.oscProgramStatus = { ...status, source: "osc", observedAt: new Date().toISOString() };
    } else {
      delete panel.oscProgramStatus;
    }
    this.observer.onPanelProgramStatusChanged?.(session, panel);
  }

  async updateLatestReply(
    terminalSessionId: string,
    panelId: string | null,
    reply: TerminalReplySnapshot,
  ): Promise<void> {
    const owner = panelId
      ? this.panels.get(panelId)
      : this.sessions.get(terminalSessionId);
    if (
      !owner ||
      ("terminalSessionId" in owner &&
        owner.terminalSessionId !== terminalSessionId)
    )
      return;
    // A delayed history read must never overwrite a newer completion.
    if (
      owner.latestReply &&
      owner.latestReply.completionRevision > reply.completionRevision
    )
      return;
    const previous = owner.latestReply;
    owner.latestReply = reply;
    try {
      await this.sessionStore.updateLatestReply(terminalSessionId, panelId, reply);
    } catch (error) {
      if (owner.latestReply === reply) owner.latestReply = previous;
      throw error;
    }
  }

  async upsertPanelWorkspace(
    workspace: TerminalPanelWorkspaceRecord,
  ): Promise<TerminalPanelWorkspaceRecord> {
    const inputSession = this.getSession(workspace.terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
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
    const inputSession = this.getSession(panel.terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
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
    const inputSession = this.getSession(terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
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
    await this.clearRecentAgentActivity(terminalSessionId, panelId);
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
    const inputSession = this.getSession(panel.terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
    delete panel.pendingPermissionRequest;
    delete panel.pendingAgyQuestion;
    this.mobilePrompts?.resolvePrompt(panel.terminalSessionId, panelId, "closed");
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
    operationId?: string | null,
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

    const inputSession = this.getSession(panel.terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
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
    this.notifyPanelMutation(panel, { operationId });
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
    operationId?: string | null,
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

    const inputSession = this.getSession(panel.terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
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
    this.notifyPanelMutation(panel, { operationId });
    return panel;
  }

  async updatePanelTerminalState(
    panelId: string,
    terminalState: TerminalState,
    operationId?: string | null,
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

    const inputSession = this.getSession(panel.terminalSessionId);
    if (inputSession) invalidateTerminalInput(inputSession);
    const previousAgent = panel.terminalState?.agent;
    panel.terminalState = terminalState;
    await this.sessionStore.updatePanelTerminalState({
      panelId,
      terminalState,
    });
    this.notifyPanelMutation(panel, { operationId });
    if (inputSession && (previousAgent === "codex" || terminalState.agent === "codex")) {
      this.observer.onPanelProgramStatusChanged?.(inputSession, panel);
    }
    return panel;
  }

  async resetPanelAgentContextForInPlaceSwitch(
    terminalSessionId: string,
    panelId: string,
    operationId?: string | null,
  ): Promise<TerminalPanelRecord | undefined> {
    const panel = this.panels.get(panelId);
    const session = this.sessions.get(terminalSessionId);
    if (!panel || !session || panel.terminalSessionId !== terminalSessionId) {
      return undefined;
    }

    const previousAgent = panel.terminalState?.agent;
    const previousThreadIds = new Set(
      [panel.threadId, panel.lastThreadId].filter(
        (value): value is string => Boolean(value),
      ),
    );
    delete panel.threadId;
    delete panel.threadProvider;
    delete panel.codexContext;
    forceClearCodexContext(terminalSessionId, panelId);
    delete panel.claude;
    delete panel.pi;
    delete panel.piLastCompletionKey;
    delete panel.agy;
    delete panel.pendingPermissionRequest;
    delete panel.pendingAgyQuestion;
    delete panel.oscProgramStatus;
    delete panel.preview;
    delete panel.latestReply;
    delete panel.lastThreadId;
    delete panel.lastThreadProvider;
    delete panel.lastThreadStatus;
    delete panel.lastThreadUpdatedAt;
    panel.activeCommand = null;
    panel.terminalState = { state: "shell_idle", agent: null };

    await this.clearRecentAgentActivity(terminalSessionId, panelId);
    await this.upsertPanel(panel);
    this.notifyPanelMutation(panel, { operationId });
    if (previousAgent === "codex") {
      this.observer.onPanelProgramStatusChanged?.(session, panel);
    }

    const workspace = this.panelWorkspaces.get(terminalSessionId);
    const sessionPanelCount = Array.from(this.panels.values()).filter(
      (candidate) => candidate.terminalSessionId === terminalSessionId,
    ).length;
    if (workspace?.activePanelId === panelId || sessionPanelCount <= 1) {
      delete session.claude;
      delete session.pi;
      delete session.agy;
      delete session.latestReply;
      if (session.lastThreadId && previousThreadIds.has(session.lastThreadId)) {
        delete session.lastThreadId;
        delete session.lastThreadProvider;
        delete session.lastThreadStatus;
        delete session.lastThreadUpdatedAt;
      }
      await this.updateSessionThreadId(terminalSessionId, null, null);
      await this.updateSessionPreview(terminalSessionId, null);
    }
    return panel;
  }

  async clearPanelsForSession(terminalSessionId: string): Promise<void> {
    this.clearRecentAgentActivitiesForSession(terminalSessionId);
    this.clearPanelAgentOperationState(terminalSessionId);
    for (const panel of this.panels.values()) {
      if (panel.terminalSessionId === terminalSessionId) {
        this.panels.delete(panel.id);
      }
    }
    this.panelWorkspaces.delete(terminalSessionId);
    await this.sessionStore.deletePanelsForSession(terminalSessionId);
  }
}
