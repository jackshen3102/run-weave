import path from "node:path";
import {
  isEvolutionRepositoryId,
  type EvolutionReflectionScope,
  type EvolutionRepository,
  type EvolutionRepositoryContext,
  type EvolutionRepositoryAttribution,
} from "@runweave/shared/evolution";
import { resolveRepositoryIdentity } from "../repository/identity";
import type { EvolutionRepositoryStore } from "./repository-store";

export class EvolutionRepositoryScopes {
  constructor(
    readonly store: EvolutionRepositoryStore,
    private readonly projects: () => Array<{
      id: string;
      name: string;
      path?: string | null;
    }>,
    private readonly projectPath: (id: string) => string | null,
  ) {}

  async register(
    cwd: string,
    projectId?: string,
  ): Promise<EvolutionRepositoryContext> {
    const identity = await resolveRepositoryIdentity(cwd);
    await this.store.repository({
      op: "put",
      repository: {
        repositoryId: identity.repositoryId,
        commonDirectory: identity.commonDirectory,
        paths: [identity.worktreeRoot],
        projectIds: projectId ? [projectId] : [],
        name: path.basename(path.dirname(identity.commonDirectory)),
      },
    });
    return {
      repositoryId: identity.repositoryId,
      cwd: identity.worktreeRoot,
      ...(projectId ? { requestedProjectId: projectId } : {}),
    };
  }

  async list(): Promise<EvolutionRepository[]> {
    for (const project of this.projects()) {
      if (project.path)
        await this.register(project.path, project.id).catch(() => undefined);
    }
    const repositories = (await this.store.repository({
      op: "list",
    })) as EvolutionRepository[];
    return Promise.all(
      repositories.map(async (repository) => {
        let available = false;
        const paths: string[] = [];
        for (const cwd of repository.paths) {
          const identity = await resolveRepositoryIdentity(cwd).catch(
            () => null,
          );
          if (identity?.repositoryId === repository.repositoryId) {
            available = true;
            paths.unshift(cwd);
          } else paths.push(cwd);
        }
        return { ...repository, paths, available };
      }),
    );
  }

  async resolve(input: {
    projectId?: string;
    scope?: EvolutionReflectionScope;
  }): Promise<EvolutionRepositoryContext> {
    if (input.scope && input.projectId !== undefined)
      throw new Error("evolution_scope_conflict");
    if (input.scope?.type === "global")
      throw new Error("evolution_global_requires_reflection_batch");
    if (input.scope?.type === "repository") {
      const { cwd, repositoryId } = input.scope;
      if (cwd) {
        const identity = await resolveRepositoryIdentity(cwd);
        if (repositoryId && identity.repositoryId !== repositoryId)
          throw new Error("evolution_repository_identity_conflict");
        return this.register(cwd);
      }
      if (!repositoryId || !isEvolutionRepositoryId(repositoryId))
        throw new Error("evolution_repository_required");
      const repository = (await this.list()).find(
        (item) => item.repositoryId === repositoryId && item.available,
      );
      if (!repository) throw new Error("evolution_repository_unavailable");
      return this.register(repository.paths[0]!);
    }
    const projectId =
      input.scope?.type === "project" ? input.scope.projectId : input.projectId;
    if (!projectId || projectId === "global:runweave")
      throw new Error("evolution_repository_required");
    const cwd = this.projectPath(projectId);
    if (!cwd) throw new Error("evolution_project_not_found");
    return this.register(cwd, projectId);
  }

  async queryScope(id: string): Promise<string> {
    const repositories = await this.list();
    if (isEvolutionRepositoryId(id)) {
      if (!repositories.some((item) => item.repositoryId === id))
        throw new Error("evolution_repository_not_found");
      return id;
    }
    // Legacy scope reads must use audited history, never today's mutable Project path.
    const attribution = (await this.store.repository({
      op: "attribution",
      kind: "scope",
      id,
    })) as EvolutionRepositoryAttribution | null;
    if (
      attribution?.resolution === "resolved" &&
      attribution.repositoryIds.length === 1
    )
      return attribution.repositoryIds[0]!;
    if (attribution?.resolution === "mixed")
      throw new Error("evolution_repository_scope_ambiguous");
    throw new Error("evolution_repository_scope_unresolved");
  }
}
