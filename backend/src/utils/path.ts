import os from "node:os";
import path from "node:path";
import {
  expandHomePath,
  resolveBrowserProfileDir,
  type BrowserProfileStorageEnv,
} from "@runweave/shared/browser-profile-node";

export { expandHomePath };

export interface StoragePaths {
  browserProfileDir: string;
  authStoreFile: string;
  terminalSessionStoreFile: string;
  terminalQuickInputStoreFile: string;
  backendLogDir: string;
}

interface StorageEnv extends BrowserProfileStorageEnv {
  AUTH_STORE_FILE?: string;
  TERMINAL_SESSION_STORE_FILE?: string;
  RUNWEAVE_BACKEND_LOG_DIR?: string;
  RUNWEAVE_ACTIVITY_HOME?: string;
  RUNWEAVE_ACTIVITY_TEST_MODE?: string;
}

export interface ActivityStoragePaths {
  activityHomeDir: string;
  activityDatabaseFile: string;
}

export function resolveActivityStoragePaths(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
): ActivityStoragePaths {
  const testHome =
    env.RUNWEAVE_ACTIVITY_TEST_MODE === "true"
      ? expandHomePath(env.RUNWEAVE_ACTIVITY_HOME, homeDir)
      : undefined;
  const activityHomeDir = path.resolve(
    testHome ?? path.join(homeDir, ".runweave", "activity"),
  );
  return {
    activityHomeDir,
    activityDatabaseFile: path.join(activityHomeDir, "activity.sqlite"),
  };
}

export function resolveStoragePaths(
  env: StorageEnv,
  homeDir: string = os.homedir(),
  projectPath: string = process.cwd(),
): StoragePaths {
  const browserProfileDir = resolveBrowserProfileDir(env, homeDir, projectPath);
  const authStoreFile = path.resolve(
    expandHomePath(env.AUTH_STORE_FILE, homeDir) ??
      path.join(browserProfileDir, "auth-store.json"),
  );
  const terminalSessionStoreFile = path.resolve(
    expandHomePath(env.TERMINAL_SESSION_STORE_FILE, homeDir) ??
      path.join(browserProfileDir, "terminal-session-store.json"),
  );
  const terminalQuickInputStoreFile = path.resolve(
    path.join(path.dirname(terminalSessionStoreFile), "terminal-quick-inputs.json"),
  );
  const backendLogDir = path.resolve(
    expandHomePath(env.RUNWEAVE_BACKEND_LOG_DIR, homeDir) ??
      path.join(browserProfileDir, "logs", "backend"),
  );

  const storagePaths = {
    browserProfileDir,
    authStoreFile,
    terminalSessionStoreFile,
    terminalQuickInputStoreFile,
  } as StoragePaths;

  Object.defineProperty(storagePaths, "backendLogDir", {
    value: backendLogDir,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return storagePaths;
}
