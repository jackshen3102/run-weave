import os from "node:os";
import path from "node:path";

export interface StoragePaths {
  browserProfileDir: string;
  sessionDbFile: string;
  terminalSessionDbFile: string;
}

interface StorageEnv {
  BROWSER_PROFILE_DIR?: string;
  SESSION_DB_FILE?: string;
  TERMINAL_SESSION_DB_FILE?: string;
}

export function expandHomePath(
  inputPath: string | undefined,
  homeDir: string = os.homedir(),
): string | undefined {
  const trimmedPath = inputPath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  if (trimmedPath === "~") {
    return homeDir;
  }

  if (trimmedPath.startsWith("~/")) {
    return path.join(homeDir, trimmedPath.slice(2));
  }

  return trimmedPath;
}

export function resolveStoragePaths(
  env: StorageEnv,
  homeDir: string = os.homedir(),
): StoragePaths {
  const defaultProfileDir = path.join(homeDir, ".browser-profile");
  const browserProfileDir = path.resolve(
    expandHomePath(env.BROWSER_PROFILE_DIR, homeDir) ?? defaultProfileDir,
  );
  const sessionDbFile = path.resolve(
    expandHomePath(env.SESSION_DB_FILE, homeDir) ??
      path.join(browserProfileDir, "session-store.db"),
  );
  const terminalSessionDbFile = path.resolve(
    expandHomePath(env.TERMINAL_SESSION_DB_FILE, homeDir) ??
      path.join(browserProfileDir, "terminal-session-store.db"),
  );

  return {
    browserProfileDir,
    sessionDbFile,
    terminalSessionDbFile,
  };
}
