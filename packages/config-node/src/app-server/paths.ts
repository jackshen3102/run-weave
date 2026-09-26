import path from "node:path";
import type { AppServerStatePaths } from "@runweave/shared/app-server/types";
import { configurationPath } from "../runtime";
import { ConfigurationError } from "../errors";

export function resolveAppServerHomeDir(options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const root = configurationPath("appServer.stateDirectory", "app-server");
  if (options.homeDir && path.resolve(options.homeDir) !== root) throw new ConfigurationError("CONFIG_APP_SERVER_ROOT_MISMATCH");
  return root;
}
export function resolveAppServerRuntimeRoot(options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(resolveAppServerHomeDir(options), "runtime");
}
export function resolveAppServerStatePaths(options: { homeDir?: string; stateDir?: string; env?: NodeJS.ProcessEnv } = {}): AppServerStatePaths {
  const homeDir = resolveAppServerHomeDir(options);
  if (options.stateDir && path.resolve(options.stateDir) !== homeDir) throw new ConfigurationError("CONFIG_APP_SERVER_ROOT_MISMATCH");
  const runtimeRoot = resolveAppServerRuntimeRoot(options);
  return { homeDir, stateDir: homeDir, lockPath: path.join(homeDir, "app-server.lock.json"), tokenPath: path.join(homeDir, "app-server-token"), eventLogPath: path.join(homeDir, "app-server-events.jsonl"), logPath: path.join(homeDir, "app-server.log"), runtimeRoot, runtimeCurrentPath: path.join(runtimeRoot, "current.json"), runtimeReleasesDir: path.join(runtimeRoot, "releases") };
}
export function trimTrailingSlash(value: string): string { return value.replace(/\/+$/, ""); }
