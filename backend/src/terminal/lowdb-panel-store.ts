import type {
  PersistedTerminalPanelRecord,
  PersistedTerminalPanelWorkspaceRecord,
  PersistedRecentAgentActivityRecord,
  UpdateTerminalPanelLastThreadParams,
  UpdateTerminalPanelPreviewParams,
  UpdateTerminalPanelStatusParams,
  UpdateTerminalPanelTerminalStateParams,
  UpdateTerminalPanelThreadIdParams,
  UpdateTerminalPanelWorkspaceParams,
  UpsertTerminalPanelParams,
} from "./store";
import { buildRecentAgentActivityKey } from "./completion-source-gate";
import { LowDbScrollbackStore } from "./lowdb-scrollback-store";

export class LowDbPanelStore extends LowDbScrollbackStore {
  async listPanels(): Promise<PersistedTerminalPanelRecord[]> {
    return this.getPanels();
  }

  async listPanelWorkspaces(): Promise<
    PersistedTerminalPanelWorkspaceRecord[]
  > {
    return this.getPanelWorkspaces();
  }

  async listRecentAgentActivities(): Promise<
    PersistedRecentAgentActivityRecord[]
  > {
    return this.getRecentAgentActivities();
  }

  async upsertRecentAgentActivity(
    activity: PersistedRecentAgentActivityRecord,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const key = buildRecentAgentActivityKey(
        activity.terminalSessionId,
        activity.panelId,
      );
      const index = database.data.recentAgentActivities.findIndex(
        (candidate) =>
          buildRecentAgentActivityKey(
            candidate.terminalSessionId,
            candidate.panelId,
          ) === key,
      );
      const persisted = structuredClone(activity);
      if (index >= 0) {
        database.data.recentAgentActivities[index] = persisted;
      } else {
        database.data.recentAgentActivities.push(persisted);
      }
      await database.write();
    });
  }

  async deleteRecentAgentActivity(
    terminalSessionId: string,
    panelId: string | null,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      const key = buildRecentAgentActivityKey(terminalSessionId, panelId);
      database.data.recentAgentActivities =
        database.data.recentAgentActivities.filter(
          (candidate) =>
            buildRecentAgentActivityKey(
              candidate.terminalSessionId,
              candidate.panelId,
            ) !== key,
        );
      await database.write();
    });
  }

  async deleteRecentAgentActivitiesForSession(
    terminalSessionId: string,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = this.getDatabase();
      database.data.recentAgentActivities =
        database.data.recentAgentActivities.filter(
          (activity) => activity.terminalSessionId !== terminalSessionId,
        );
      await database.write();
    });
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
        panel.threadProvider = params.provider ?? undefined;
      } else {
        delete panel.threadId;
        delete panel.threadProvider;
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
      panel.lastThreadProvider = params.provider;
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
      database.data.recentAgentActivities =
        database.data.recentAgentActivities.filter(
          (activity) => activity.terminalSessionId !== terminalSessionId,
        );
      await database.write();
    });
  }
}
