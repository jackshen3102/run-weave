import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionMetadataRecord,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalProjectParams,
  UpdateTerminalSessionActivityParams,
  UpdateTerminalSessionAliasParams,
  UpdateTerminalSessionCompletionParams,
  UpdateTerminalSessionExitParams,
  UpdateTerminalSessionLastThreadParams,
  UpdateTerminalSessionLaunchParams,
  UpdateTerminalSessionMetadataParams,
  UpdateTerminalSessionPanelSplitEnabledParams,
  UpdateTerminalSessionPreviewParams,
  UpdateTerminalSessionRuntimeMetadataParams,
  UpdateTerminalSessionStatusParams,
  UpdateTerminalSessionTerminalStateParams,
  UpdateTerminalSessionThreadIdParams,
} from "./store";
import { LowDbPanelStore } from "./lowdb-panel-store";
import { toMetadataRecord } from "./lowdb-records";

export class LowDbTerminalSessionStore
  extends LowDbPanelStore
  implements TerminalSessionStore
{
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
        (workspace) => !childSessionIds.includes(workspace.terminalSessionId),
      );
      database.data.recentAgentActivities =
        database.data.recentAgentActivities.filter(
          (activity) => !childSessionIds.includes(activity.terminalSessionId),
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
        session.threadProvider = params.provider ?? undefined;
      } else {
        delete session.threadId;
        delete session.threadProvider;
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
      session.lastThreadProvider = params.provider;
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

  async updateSessionCompletion(
    params: UpdateTerminalSessionCompletionParams,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      session.completionRevision = params.completionRevision;
      session.acknowledgedCompletionRevision =
        params.acknowledgedCompletionRevision;
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
      database.data.recentAgentActivities =
        database.data.recentAgentActivities.filter(
          (activity) => activity.terminalSessionId !== terminalSessionId,
        );
      await database.write();
    });
    await this.enqueueScrollbackWrite(async () => {
      await this.deleteScrollbackFile(terminalSessionId);
    });
  }
}
