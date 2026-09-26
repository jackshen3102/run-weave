import { configurationPath, configuration, configurationOption } from "@runweave/config-node";
import path from "node:path";

export interface AppServerConfig {
  host: "127.0.0.1";
  requestedPort: number;
  stateDir: string;
  lockPath: string;
  tokenPath: string;
  eventLogPath: string;
  threadStatePath: string;
  cloudSyncDir: string;
  version: string;
  source: "global" | "local" | "bundled";
  releaseId: string | null;
  entry: string;
  runtimeRoot: string | null;
  serviceInstanceId: string | null;
  devSessionId: string | null;
  sourceRevision: string | null;
}

export function resolveAppServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppServerConfig {
  configuration().requireDomain("appServer");
  const stateDir = configurationPath("appServer.stateDirectory", "app-server");
  return {
    host: "127.0.0.1",
    requestedPort: parsePort(configurationOption("port")),
    stateDir,
    lockPath: path.join(stateDir, "app-server.lock.json"),
    tokenPath: path.join(stateDir, "app-server-token"),
    eventLogPath: path.join(stateDir, "app-server-events.jsonl"),
    threadStatePath: path.join(stateDir, "app-server-thread-state.json"),
    cloudSyncDir: configurationPath("appServer.cloudSyncDirectory", "app-server/cloud-sync"),
    version: "0.1.0",
    source: parseSource(env.RUNWEAVE_APP_SERVER_SOURCE),
    releaseId: env.RUNWEAVE_APP_SERVER_RELEASE_ID?.trim() || null,
    entry: env.RUNWEAVE_APP_SERVER_ENTRY?.trim() || process.argv[1] || "",
    runtimeRoot: env.RUNWEAVE_APP_SERVER_RUNTIME_ROOT?.trim() || null,
    serviceInstanceId: env.RUNWEAVE_SERVICE_INSTANCE_ID?.trim() || null,
    devSessionId: configuration().context.kind === "dev" ? configuration().context.instanceId : null,
    sourceRevision: env.RUNWEAVE_SOURCE_REVISION?.trim() || null,
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
