import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHomePath } from "../utils/path";
import type { SessionProfileMode } from "./store";

export class SessionProfileValidationError extends Error {}

export class SessionProfileConflictError extends Error {}

export interface SessionProfileBinding {
  profileMode: SessionProfileMode;
  profilePath: string;
}

export interface ResolveSessionProfileBindingOptions {
  sessionId: string;
  customProfilePath?: string;
  activeProfilePaths: Iterable<string>;
  getManagedProfilePath(sessionId: string): string;
}

export async function resolveSessionProfileBinding(
  options: ResolveSessionProfileBindingOptions,
): Promise<SessionProfileBinding> {
  if (!options.customProfilePath) {
    return {
      profileMode: "managed",
      profilePath: options.getManagedProfilePath(options.sessionId),
    };
  }

  const resolvedProfilePath = path.resolve(
    expandHomePath(options.customProfilePath, os.homedir()) ??
      options.customProfilePath,
  );

  await validateCustomProfilePath(resolvedProfilePath);
  ensureProfilePathAvailable(resolvedProfilePath, options.activeProfilePaths);

  return {
    profileMode: "custom",
    profilePath: resolvedProfilePath,
  };
}

function ensureProfilePathAvailable(
  profilePath: string,
  activeProfilePaths: Iterable<string>,
): void {
  for (const activeProfilePath of activeProfilePaths) {
    if (activeProfilePath === profilePath) {
      throw new SessionProfileConflictError(
        "Custom profile path is already in use by another session",
      );
    }
  }
}

async function validateCustomProfilePath(profilePath: string): Promise<void> {
  let profileStats;
  try {
    profileStats = await stat(profilePath);
  } catch {
    throw new SessionProfileValidationError(
      "Custom profile path does not exist",
    );
  }

  if (!profileStats.isDirectory()) {
    throw new SessionProfileValidationError(
      "Custom profile path must point to a directory",
    );
  }

  try {
    await access(profilePath, constants.R_OK | constants.W_OK);
  } catch {
    throw new SessionProfileValidationError(
      "Custom profile path must be readable and writable",
    );
  }
}
