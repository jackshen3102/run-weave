import {
  discoverAppServer,
  getAppServerStatus,
} from "@runweave/shared/app-server/discovery";
import type { AppServerConnectionInfo } from "@runweave/shared/app-server/types";

export interface AppServerCliLogger {
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
}

export async function checkAppServerAvailability(options: {
  env: NodeJS.ProcessEnv;
  logger?: AppServerCliLogger;
}): Promise<AppServerConnectionInfo | null> {
  const status = await getAppServerStatus({ env: options.env });
  if (!status.available) {
    options.logger?.warn("appServer.unavailable", {
      baseUrl: status.baseUrl,
      hasToken: status.hasToken,
      lockPath: status.lockPath,
      pid: status.pid,
      staleLock: status.staleLock,
    });
    return null;
  }

  const connection = await discoverAppServer({ env: options.env });
  if (!connection) {
    options.logger?.warn("appServer.connection.unavailable", {
      baseUrl: status.baseUrl,
      lockPath: status.lockPath,
      pid: status.pid,
      releaseId: status.lock?.releaseId ?? null,
    });
    return null;
  }

  options.logger?.info("appServer.connected", {
    baseUrl: connection.baseUrl,
    pid: status.pid,
    releaseId: status.lock?.releaseId ?? null,
  });
  return connection;
}
