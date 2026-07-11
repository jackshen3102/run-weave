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
