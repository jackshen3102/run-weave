/* global AbortSignal, AbortController, clearTimeout, fetch, module, process, setTimeout */

const APP_SERVER_SERVICE_NAME = "runweave-app-server";
const APP_SERVER_PROTOCOL_VERSION = 1;

async function discoverAppServer() {
  // Hooks only receive a verified launch context from their owning Backend.
  // Never search another instance's global lock/token files.
  const baseUrl = process.env.RUNWEAVE_APP_SERVER_URL?.trim();
  const token = process.env.RUNWEAVE_APP_SERVER_TOKEN?.trim();
  const kind = process.env.RUNWEAVE_RUNTIME_KIND;
  const instanceId = process.env.RUNWEAVE_RUNTIME_INSTANCE_ID;
  const configRoot = process.env.RUNWEAVE_RUNTIME_CONFIG_ROOT;
  if (!baseUrl || !token || !["stable", "dev"].includes(kind) || !instanceId || !configRoot) return null;
  return healthCheck({ baseUrl: trimTrailingSlash(baseUrl), token, environment: { kind, instanceId, configRoot } });
}

async function healthCheck(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`${candidate.baseUrl}/healthz`, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    if (
      body?.ok !== true ||
      body?.service !== APP_SERVER_SERVICE_NAME ||
      body?.protocolVersion !== APP_SERVER_PROTOCOL_VERSION ||
      body?.environment?.kind !== candidate.environment.kind ||
      body?.environment?.instanceId !== candidate.environment.instanceId ||
      body?.environment?.configRoot !== candidate.environment.configRoot
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
      redirect: "error",
      signal: AbortSignal.timeout(5000),
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

module.exports = {
  discoverAppServer,
  postAppServerEvent,
};
