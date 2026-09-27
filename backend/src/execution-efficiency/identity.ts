import path from "node:path";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { ExecutionEfficiencyError } from "./errors";

export interface EfficiencyProjectScope {
  projectId: string;
  repositoryId: string;
  paths: string[];
}

export function resolveEfficiencyProjectScope(
  terminalSessionManager: TerminalSessionManager,
  projectId: string,
): EfficiencyProjectScope {
  const project = terminalSessionManager.getProject(projectId);
  if (!project?.path) {
    throw new ExecutionEfficiencyError(
      "project_not_found",
      404,
      "Project is unavailable or has no local path",
    );
  }
  const repositoryId = terminalSessionManager.resolveParentProjectId(projectId);
  const parent = terminalSessionManager.getProject(repositoryId);
  const paths = new Set<string>();
  if (parent?.path) paths.add(path.resolve(parent.path));
  for (const context of terminalSessionManager.listProjectContexts(repositoryId)) {
    if (context.path && context.availability === "available")
      paths.add(path.resolve(context.path));
  }
  paths.add(path.resolve(project.path));
  return { projectId, repositoryId, paths: [...paths] };
}
