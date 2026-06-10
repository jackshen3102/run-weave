import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { z } from "zod";
import type { CreateTerminalSessionRequest } from "@browser-viewer/shared";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  resolveDefaultTerminalArgs,
  resolveDefaultTerminalCommand,
} from "../terminal/default-shell";

export const createTerminalSessionSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    inheritFromTerminalSessionId: z.string().trim().min(1).optional(),
    runtimePreference: z.enum(["auto", "tmux", "pty"]).optional(),
  })
  .strict();

export const sendTerminalInputSchema = z
  .object({
    data: z.string(),
    operationId: z.string().trim().min(1).optional(),
  })
  .strict();

export const sendTerminalInterruptSchema = z
  .object({
    operationId: z.string().trim().min(1).optional(),
  })
  .strict();

export const TERMINAL_INTERRUPT_ESCAPE_INPUT = "\x1b";

export function buildTerminalInputOperationId(): string {
  return `op_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
}

export function resolveTerminalCreateDefaults(
  payload: CreateTerminalSessionRequest,
  terminalSessionManager: TerminalSessionManager,
): {
  projectId?: string;
  command: string;
  args?: string[];
  cwd: string;
} {
  const command = payload.command?.trim() || resolveDefaultTerminalCommand();
  const inheritedCwd = payload.inheritFromTerminalSessionId
    ? terminalSessionManager.getSession(payload.inheritFromTerminalSessionId)
        ?.cwd
    : undefined;
  const projectId =
    payload.projectId ??
    terminalSessionManager.listProjects().find((project) => project.isDefault)
      ?.id;
  const projectPath = projectId
    ? terminalSessionManager.getProject(projectId)?.path
    : undefined;
  const cwd =
    payload.cwd?.trim() ||
    (isExistingDirectory(inheritedCwd) ? inheritedCwd : undefined) ||
    projectPath ||
    os.homedir();

  return {
    projectId: payload.projectId,
    command,
    args: payload.args ?? resolveDefaultTerminalArgs(command),
    cwd,
  };
}

export function sanitizeTerminalError(error: unknown): string {
  const hookToken = process.env.RUNWEAVE_HOOK_TOKEN?.trim();
  const raw = String(error);
  const withoutKnownToken = hookToken
    ? raw.replaceAll(hookToken, "[redacted]")
    : raw;
  return withoutKnownToken.replace(
    /RUNWEAVE_HOOK_TOKEN=[^\s'"]+/g,
    "RUNWEAVE_HOOK_TOKEN=[redacted]",
  );
}

function isExistingDirectory(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}
