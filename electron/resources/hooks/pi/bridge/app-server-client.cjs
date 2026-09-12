/* global AbortController, clearTimeout, fetch, module, process, require, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_SERVER_SERVICE_NAME = "runweave-app-server";
const APP_SERVER_PROTOCOL_VERSION = 1;

async function discoverAppServer() {
  const discoveryMode = process.env.RUNWEAVE_APP_SERVER_DISCOVERY?.trim();
  if (discoveryMode === "disabled") {
    return null;
  }
  const fromEnv = await discoverFromEnv();
  if (fromEnv) {
    return fromEnv;
  }
  if (discoveryMode === "explicit") {
    return null;
  }
  return discoverFromDefaultFiles();
}

async function discoverFromEnv() {
  const baseUrl = process.env.RUNWEAVE_APP_SERVER_URL?.trim();
  const token = process.env.RUNWEAVE_APP_SERVER_TOKEN?.trim();
  if (!baseUrl || !token) {
    return null;
  }
  return healthCheck({ baseUrl: trimTrailingSlash(baseUrl), token });
}

async function discoverFromDefaultFiles() {
  const configuredStateDir =
    process.env.RUNWEAVE_APP_SERVER_STATE_DIR?.trim() ||
    process.env.RUNWEAVE_APP_SERVER_HOME?.trim();
  const stateDir = configuredStateDir
    ? path.resolve(expandHomePath(configuredStateDir))
    : path.join(os.homedir(), ".runweave", "app-server");
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(stateDir, "app-server.lock.json"), "utf8"),
    );
    if (
      lock?.host !== "127.0.0.1" ||
      typeof lock?.port !== "number" ||
      !Number.isInteger(lock.port)
    ) {
      return null;
    }
    const token = fs
      .readFileSync(path.join(stateDir, "app-server-token"), "utf8")
      .trim();
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

async function healthCheck(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`${candidate.baseUrl}/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    if (
      body?.ok !== true ||
      body?.service !== APP_SERVER_SERVICE_NAME ||
      body?.protocolVersion !== APP_SERVER_PROTOCOL_VERSION
    ) {
      return null;
    }
    if (candidate.expectedPid !== undefined && body.pid !== candidate.expectedPid) {
      return null;
    }
    return { baseUrl: candidate.baseUrl, token: candidate.token };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postAppServerEvent(client, event) {
  if (!client) {
    return { ok: false, unavailable: true };
  }
  try {
    const response = await fetch(`${client.baseUrl}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function expandHomePath(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

module.exports = {
  discoverAppServer,
  postAppServerEvent,
};
