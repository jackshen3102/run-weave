import os from "node:os";
import path from "node:path";
import type { AppServerStatePaths } from "./types";

export function resolveAppServerStatePaths(
  options: {
    homeDir?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): AppServerStatePaths {
  const env = options.env ?? process.env;
  const homeDir = resolveAppServerHomeDir({ homeDir: options.homeDir, env });
  const stateDir = path.resolve(
    expandHomePath(options.stateDir ?? env.RUNWEAVE_APP_SERVER_STATE_DIR) ??
      homeDir,
  );
  const runtimeRoot = resolveAppServerRuntimeRoot({ homeDir, env });
  return {
    homeDir,
    stateDir,
    lockPath: path.join(stateDir, "app-server.lock.json"),
    tokenPath: path.join(stateDir, "app-server-token"),
    eventLogPath: path.join(stateDir, "app-server-events.jsonl"),
    logPath: path.join(stateDir, "app-server.log"),
    runtimeRoot,
    runtimeCurrentPath: path.join(runtimeRoot, "current.json"),
    runtimeReleasesDir: path.join(runtimeRoot, "releases"),
  };
}

export function resolveAppServerHomeDir(
  options: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(
    expandHomePath(options.homeDir ?? env.RUNWEAVE_APP_SERVER_HOME) ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
}

export function resolveAppServerRuntimeRoot(
  options: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(
    expandHomePath(env.RUNWEAVE_APP_SERVER_RUNTIME_ROOT) ??
      path.join(
        options.homeDir
          ? path.resolve(expandHomePath(options.homeDir) ?? options.homeDir)
          : resolveAppServerHomeDir({ env }),
        "runtime",
      ),
  );
}

export function expandHomePath(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
