import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface StoragePaths {
  browserProfileDir: string;
  authStoreFile: string;
  sessionStoreFile: string;
  terminalSessionStoreFile: string;
}

interface StorageEnv {
  BROWSER_PROFILE_DIR?: string;
  AUTH_STORE_FILE?: string;
  SESSION_STORE_FILE?: string;
  TERMINAL_SESSION_STORE_FILE?: string;
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
  projectPath: string = process.cwd(),
): StoragePaths {
  const trimmedProjectPath = projectPath.trim();
  const defaultProfileRootDir = path.join(homeDir, ".browser-profile");
  const defaultProfileDir =
    trimmedProjectPath.length > 0
      ? path.join(
          defaultProfileRootDir,
          createHash("sha256")
            .update(trimmedProjectPath)
            .digest("hex")
            .slice(0, 8),
        )
      : defaultProfileRootDir;
  const browserProfileDir = path.resolve(
    expandHomePath(env.BROWSER_PROFILE_DIR, homeDir) ?? defaultProfileDir,
  );
  const authStoreFile = path.resolve(
    expandHomePath(env.AUTH_STORE_FILE, homeDir) ??
      path.join(browserProfileDir, "auth-store.json"),
  );
  const sessionStoreFile = path.resolve(
    expandHomePath(env.SESSION_STORE_FILE, homeDir) ??
      path.join(browserProfileDir, "session-store.json"),
  );
  const terminalSessionStoreFile = path.resolve(
    expandHomePath(env.TERMINAL_SESSION_STORE_FILE, homeDir) ??
      path.join(browserProfileDir, "terminal-session-store.json"),
  );

  return {
    browserProfileDir,
    authStoreFile,
    sessionStoreFile,
    terminalSessionStoreFile,
  };
}
