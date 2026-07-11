export const APP_SERVER_SERVICE_NAME = "runweave-app-server";
export const APP_SERVER_PROTOCOL_VERSION = 1;
export const APP_SERVER_RUNTIME_SCHEMA_VERSION = 1;

export type AppServerRuntimeSource = "global" | "local" | "bundled";

export interface AppServerLock {
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  version: string;
  source: AppServerRuntimeSource;
  releaseId: string | null;
  entry: string;
  runtimeRoot: string | null;
}

export interface AppServerConnectionInfo {
  baseUrl: string;
  token: string;
}

export interface AppServerHealth {
  ok: boolean;
  service: string;
  protocolVersion: number;
  pid: number;
  version?: string;
}

export interface AppServerStatus {
  available: boolean;
  baseUrl: string | null;
  hasToken: boolean;
  health: AppServerHealth | null;
  lock: AppServerLock | null;
  lockPath: string;
  pid: number | null;
  stateDir: string;
  staleLock: boolean;
  tokenPath: string;
  runtimeRoot: string;
  currentRuntime: AppServerRuntimeRelease | null;
}

export interface AppServerStatePaths {
  homeDir: string;
  stateDir: string;
  lockPath: string;
  tokenPath: string;
  eventLogPath: string;
  logPath: string;
  runtimeRoot: string;
  runtimeCurrentPath: string;
  runtimeReleasesDir: string;
}

export interface AppServerRuntimeRelease {
  source: AppServerRuntimeSource;
  releaseId: string;
  entry: string;
  releaseDir: string | null;
  runtimeRoot: string | null;
}
