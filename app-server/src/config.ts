import os from "node:os";
import path from "node:path";

export interface AppServerConfig {
  host: "127.0.0.1";
  requestedPort: number;
  stateDir: string;
  lockPath: string;
  tokenPath: string;
  eventLogPath: string;
  version: string;
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
    version: "0.1.0",
  };
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
