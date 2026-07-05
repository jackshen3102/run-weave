import os from "node:os";
import path from "node:path";

export interface AppServerConfig {
  host: "127.0.0.1";
  requestedPort: number;
  stateDir: string;
  lockPath: string;
  tokenPath: string;
  eventLogPath: string;
  threadStatePath: string;
  agentSessionStatePath: string;
  cloudSyncDir: string;
  version: string;
  source: "global" | "local" | "bundled";
  releaseId: string | null;
  entry: string;
  runtimeRoot: string | null;
}

export function resolveAppServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppServerConfig {
  const stateDir = path.resolve(
    expandHomePath(env.RUNWEAVE_APP_SERVER_STATE_DIR) ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
  return {
    host: "127.0.0.1",
    requestedPort: parsePort(env.RUNWEAVE_APP_SERVER_PORT),
    stateDir,
    lockPath: path.join(stateDir, "app-server.lock.json"),
    tokenPath: path.join(stateDir, "app-server-token"),
    eventLogPath: path.join(stateDir, "app-server-events.jsonl"),
    threadStatePath: path.join(stateDir, "app-server-thread-state.json"),
    agentSessionStatePath: path.join(
      stateDir,
      "app-server-agent-session-state.json",
    ),
    cloudSyncDir: path.resolve(
      expandHomePath(env.RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR) ??
        path.join(os.homedir(), ".runweave", "app-server-cloud-sync-sim"),
    ),
    version: "0.1.0",
    source: parseSource(env.RUNWEAVE_APP_SERVER_SOURCE),
    releaseId: env.RUNWEAVE_APP_SERVER_RELEASE_ID?.trim() || null,
    entry: env.RUNWEAVE_APP_SERVER_ENTRY?.trim() || process.argv[1] || "",
    runtimeRoot: env.RUNWEAVE_APP_SERVER_RUNTIME_ROOT?.trim() || null,
  };
}

function parseSource(raw: string | undefined): "global" | "local" | "bundled" {
  if (raw === "local" || raw === "bundled") {
    return raw;
  }
  return "global";
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) {
    return 0;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return 0;
  }
  return port;
}

function expandHomePath(value: string | undefined): string | null {
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
