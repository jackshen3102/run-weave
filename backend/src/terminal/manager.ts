import { v4 as uuidv4 } from "uuid";
import { applyProjectOrder, applySessionOrder } from "./manager-ordering";
import {
  createRuntimeRecord,
  toPersistedProject,
  toPersistedSession,
  type CreateTerminalSessionOptions,
  type TerminalProjectRecord,
  type TerminalSessionRecord,
} from "./manager-records";
import { getInitialTerminalActiveCommand } from "./session-launch";
import { createUniqueTerminalSessionId } from "./session-id";
import { TerminalManagerPanelOperations } from "./manager-panel-operations";

export type {
  CreateTerminalSessionOptions,
  TerminalPanelRecord,
  TerminalPanelWorkspaceRecord,
  TerminalProjectRecord,
  TerminalSessionRecord,
} from "./manager-records";
export type {
  TerminalPanelMutationListener,
  TerminalSessionManagerObserver,
} from "./manager-base";

export class TerminalSessionManager extends TerminalManagerPanelOperations {
  async createProject(
    name: string,
    projectPath?: string | null,
  ): Promise<TerminalProjectRecord> {
    const project: TerminalProjectRecord = {
      id: uuidv4(),
      name: name.trim(),
      path: projectPath?.trim() || null,
      createdAt: new Date(),
      isDefault: this.projects.size === 0,
    };

    await this.sessionStore.insertProject(toPersistedProject(project));
    this.projects.set(project.id, project);
    if (project.isDefault) {
      await this.sessionStore.setDefaultProject(project.id);
    }
    return project;
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; path?: string | null },
  ): Promise<TerminalProjectRecord | undefined> {
    const project = this.projects.get(projectId);
    if (!project) {
      return undefined;
    }

    if (patch.name !== undefined) {
      project.name = patch.name.trim();
    }
    if ("path" in patch) {
      project.path = patch.path?.trim() || null;
    }
    await this.sessionStore.updateProject({
      projectId,
      name: project.name,
      path: project.path,
    });
    return project;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const project = this.projects.get(projectId);
    if (!project) {
      return false;
    }

    const childSessionIds = this.listSessions()
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id);
    for (const sessionId of childSessionIds) {
      await this.destroySession(sessionId);
    }

    this.projects.delete(projectId);
    await this.sessionStore.deleteProject(projectId);

    if (this.projects.size === 0) {
      await this.createProject("Default Project");
      return true;
    }

    if (project.isDefault) {
      const nextDefault = this.listProjects()[0];
      if (nextDefault) {
        for (const candidate of this.projects.values()) {
          candidate.isDefault = candidate.id === nextDefault.id;
        }
        await this.sessionStore.setDefaultProject(nextDefault.id);
      }
    }

    return true;
  }

  async reorderProjects(orderedIds: string[]): Promise<void> {
    applyProjectOrder(this.projects.values(), orderedIds);
    await this.sessionStore.reorderProjects(orderedIds);
  }

  async reorderSessions(
    projectId: string,
    orderedIds: string[],
  ): Promise<void> {
    applySessionOrder(this.sessions.values(), projectId, orderedIds);
    await this.sessionStore.reorderSessions(projectId, orderedIds);
  }

  private getDefaultProjectId(): string {
    const currentDefault = this.listProjects().find(
      (project) => project.isDefault,
    );
    if (currentDefault) {
      return currentDefault.id;
    }

    const fallback = this.listProjects()[0];
    if (fallback) {
      fallback.isDefault = true;
      void this.sessionStore.setDefaultProject(fallback.id);
      return fallback.id;
    }

    throw new Error("[viewer-be] terminal default project not initialized");
  }

  async createSession(
    options: CreateTerminalSessionOptions,
  ): Promise<TerminalSessionRecord> {
    const now = new Date();
    const projectId = options.projectId ?? this.getDefaultProjectId();
    const session = createRuntimeRecord({
      id: createUniqueTerminalSessionId((candidate) =>
        this.sessions.has(candidate),
      ),
      projectId,
      alias: null,
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      activeCommand: getInitialTerminalActiveCommand(options.command),
      scrollback: "",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
      runtimeKind: "pty",
      recoverable: false,
      completionRevision: 0,
      acknowledgedCompletionRevision: 0,
      panelSplitEnabled: false,
    });

    await this.sessionStore.insertSession(toPersistedSession(session));
    this.sessions.set(session.id, session);
    this.observeActiveCommand(session.id, session.activeCommand);
    return session;
  }
}
