import { existsSync, statSync } from "node:fs";
import os from "node:os";
import type { CreateTerminalSessionRequest } from "@runweave/shared/terminal/session";
import type { TerminalSessionManager } from "../manager/manager";
import { resolveDefaultTerminalArgs, resolveDefaultTerminalCommand } from "../runtime/default-shell";

export class TerminalCreateDefaultsError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "TerminalCreateDefaultsError";
  }
}

export function resolveTerminalCreateDefaults(
  payload: CreateTerminalSessionRequest,
  terminalSessionManager: TerminalSessionManager,
): { projectId?: string; command: string; args?: string[]; cwd: string } {
  const command = payload.command?.trim() || resolveDefaultTerminalCommand();
  const inheritedSession = payload.inheritFromTerminalSessionId
    ? terminalSessionManager.getSession(payload.inheritFromTerminalSessionId)
    : undefined;
  if (payload.inheritFromTerminalSessionId && !inheritedSession) throw new TerminalCreateDefaultsError("Inherited terminal session not found", 404);
  const projectId = payload.projectId ?? inheritedSession?.projectId ?? terminalSessionManager.listProjects().find((project) => project.isDefault)?.id;
  const projectPath = projectId ? terminalSessionManager.getProject(projectId)?.path : undefined;
  if (projectId && !terminalSessionManager.getProject(projectId)) {
    const context = terminalSessionManager.getProjectContext(projectId);
    throw new TerminalCreateDefaultsError(context ? "Terminal project context is unavailable" : "Terminal project not found", context ? 409 : 404);
  }
  const cwd = payload.cwd?.trim() || (isExistingDirectory(inheritedSession?.cwd) ? inheritedSession?.cwd : undefined) || projectPath || os.homedir();
  return { projectId, command, args: payload.args ?? resolveDefaultTerminalArgs(command), cwd };
}

function isExistingDirectory(value: string | undefined): boolean {
  if (!value) return false;
  try { return existsSync(value) && statSync(value).isDirectory(); } catch { return false; }
}
