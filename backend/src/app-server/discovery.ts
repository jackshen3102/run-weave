import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const APP_SERVER_SERVICE_NAME = "runweave-app-server";
const APP_SERVER_PROTOCOL_VERSION = 1;

export interface AppServerConnectionInfo {
  baseUrl: string;
  token: string;
}

export async function discoverAppServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppServerConnectionInfo | null> {
  const fromEnv = await discoverFromEnv(env);
  if (fromEnv) {
    return fromEnv;
  }
  return discoverFromDefaultFiles(env);
}

async function discoverFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<AppServerConnectionInfo | null> {
  const baseUrl = env.RUNWEAVE_APP_SERVER_URL?.trim();
  const token = env.RUNWEAVE_APP_SERVER_TOKEN?.trim();
  if (!baseUrl || !token) {
    return null;
  }
  return healthCheck({ baseUrl: trimTrailingSlash(baseUrl), token });
}

async function discoverFromDefaultFiles(
  env: NodeJS.ProcessEnv,
): Promise<AppServerConnectionInfo | null> {
  const stateDir = env.RUNWEAVE_APP_SERVER_STATE_DIR?.trim()
    ? path.resolve(expandHomePath(env.RUNWEAVE_APP_SERVER_STATE_DIR))
    : path.join(os.homedir(), ".runweave", "app-server");
  try {
    const lock = JSON.parse(
      await readFile(path.join(stateDir, "app-server.lock.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      lock.host !== "127.0.0.1" ||
      typeof lock.port !== "number" ||
      !Number.isInteger(lock.port)
    ) {
      return null;
    }
    const token = (
      await readFile(path.join(stateDir, "app-server-token"), "utf8")
    ).trim();
    if (!token) {
      return null;
    }
    return healthCheck({
      baseUrl: `http://${lock.host}:${lock.port}`,
      token,
      expectedPid: typeof lock.pid === "number" ? lock.pid : null,
    });
  } catch {
    return null;
  }
}

async function healthCheck(options: {
  baseUrl: string;
  token: string;
  expectedPid?: number | null;
}): Promise<AppServerConnectionInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${options.baseUrl}/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (
      body.ok !== true ||
      body.service !== APP_SERVER_SERVICE_NAME ||
      body.protocolVersion !== APP_SERVER_PROTOCOL_VERSION
    ) {
      return null;
    }
    if (options.expectedPid !== undefined && body.pid !== options.expectedPid) {
      return null;
    }
    return { baseUrl: options.baseUrl, token: options.token };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
