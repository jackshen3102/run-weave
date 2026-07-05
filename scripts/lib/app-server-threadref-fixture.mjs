import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VALID_APP_SERVER_EVENT_SOURCE_APPS = new Set([
  "app-server",
  "backend",
  "electron",
  "cli",
  "hook",
  "unknown",
]);

export const DEFAULT_FIXTURE_SOURCE = {
  app: "hook",
  instanceId: "hook-threadref-fixture",
  pid: process.pid,
};

export async function discoverAppServerFromEnv(env = process.env) {
  const stateDirOverride =
    env.RUNWEAVE_APP_SERVER_STATE_DIR?.trim() || env.RUNWEAVE_APP_SERVER_HOME?.trim();
  const envBaseUrl = env.RUNWEAVE_APP_SERVER_URL?.trim();
  const envToken = env.RUNWEAVE_APP_SERVER_TOKEN?.trim();
  if (!stateDirOverride && envBaseUrl && envToken) {
    const context = { baseUrl: trimTrailingSlash(envBaseUrl), token: envToken };
    await assertAppServerAvailable(context);
    return context;
  }

  const stateDir = resolveAppServerStateDir(env);
  const lock = JSON.parse(
    await readFile(path.join(stateDir, "app-server.lock.json"), "utf8"),
  );
  const token = (await readFile(path.join(stateDir, "app-server-token"), "utf8")).trim();
  const context = {
    baseUrl: `http://${lock.host}:${lock.port}`,
    token,
  };
  await assertAppServerAvailable(context);
  return context;
}

export function buildHookEvent(ids, hookEventName, overrides = {}) {
  const source = normalizeSource(overrides.source ?? DEFAULT_FIXTURE_SOURCE);
  const scope = {
    projectId: ids.projectId,
    terminalSessionId: ids.terminalSessionId,
    terminalPanelId: ids.terminalPanelId,
    runId: ids.runId,
    cwd: ids.cwd,
    ...(overrides.scope ?? {}),
  };
  return {
    kind: "agent.hook",
    source,
    scope,
    correlationId:
      "correlationId" in overrides ? overrides.correlationId : ids.threadId,
    dedupeKey: overrides.dedupeKey ?? null,
    payload: {
      source: ids.agent ?? "codex",
      stateHookEvent: hookEventName,
      ...(overrides.payload ?? {}),
    },
  };
}

export function buildCompletionEvent(ids, reason, rawHookEvent, overrides = {}) {
  const source = normalizeSource(overrides.source ?? DEFAULT_FIXTURE_SOURCE);
  return {
    kind: "agent.completion",
    source,
    scope: {
      projectId: ids.projectId,
      terminalSessionId: ids.terminalSessionId,
      terminalPanelId: ids.terminalPanelId,
      runId: ids.runId,
      cwd: ids.cwd,
      ...(overrides.scope ?? {}),
    },
    correlationId:
      "correlationId" in overrides ? overrides.correlationId : ids.threadId,
    dedupeKey: overrides.dedupeKey ?? null,
    payload: {
      source: ids.agent ?? "codex",
      completionReason: reason,
      rawHookEvent,
      ...(overrides.payload ?? {}),
    },
  };
}

export async function seedThreadRefFixture(context, params) {
  const statuses = params.statuses ?? ["running", "starting"];
  const threads = [];
  for (const status of statuses) {
    const ids = {
      projectId: params.projectId,
      terminalSessionId: params.terminalSessionId,
      terminalPanelId: params.terminalPanelId ?? null,
      runId: params.runId ?? null,
      cwd: params.cwd ?? process.cwd(),
      agent: params.agent ?? "codex",
      threadId:
        params.threadIds?.[status] ??
        `${params.prefix ?? "threadref-fixture"}-${status}-${Date.now()}`,
    };
    const eventIds = await seedStatus(context, ids, status);
    const thread = await getThread(context, ids.threadId);
    assert.equal(thread.thread.status, status, `${ids.threadId} status`);
    assert.equal(
      thread.thread.terminalSessionId,
      params.terminalSessionId,
      `${ids.threadId} terminalSessionId`,
    );
    threads.push({
      threadId: ids.threadId,
      status,
      eventIds,
    });
  }
  return {
    projectId: params.projectId,
    terminalSessionId: params.terminalSessionId,
    threads,
  };
}

export async function postEvent(context, body) {
  const response = await fetch(`${context.baseUrl}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`POST /events returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export async function getThread(context, threadId) {
  return getJson(context, `/threads/${encodeURIComponent(threadId)}`);
}

export async function getJson(context, pathName) {
  const response = await fetch(`${context.baseUrl}${pathName}`, {
    headers: { Authorization: `Bearer ${context.token}` },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${pathName} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function assertAppServerAvailable(context) {
  try {
    const response = await fetch(`${context.baseUrl}/healthz`);
    if (!response.ok) {
      throw new Error(`GET /healthz returned ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `Discovered App Server at ${context.baseUrl}, but it is not reachable. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function seedStatus(context, ids, status) {
  if (status === "starting") {
    return [await postFixtureEvent(context, buildHookEvent(ids, "SessionStart"))];
  }
  if (status === "running") {
    return [await postFixtureEvent(context, buildHookEvent(ids, "UserPromptSubmit"))];
  }
  if (status === "idle") {
    return [
      await postFixtureEvent(context, buildHookEvent(ids, "UserPromptSubmit")),
      await postFixtureEvent(context, buildHookEvent(ids, "Stop")),
    ];
  }
  if (status === "completed") {
    return [
      await postFixtureEvent(context, buildHookEvent(ids, "UserPromptSubmit")),
      await postFixtureEvent(
        context,
        buildCompletionEvent(ids, "ai_process_exit", "Exit"),
      ),
    ];
  }
  throw new Error(
    `Unsupported fixture status "${status}". Supported: starting, running, idle, completed.`,
  );
}

async function postFixtureEvent(context, event) {
  const payload = await postEvent(context, event);
  return payload.event.id;
}

function normalizeSource(source) {
  if (
    !source ||
    typeof source !== "object" ||
    !VALID_APP_SERVER_EVENT_SOURCE_APPS.has(source.app)
  ) {
    throw new Error("Invalid App Server event source");
  }
  return {
    app: source.app,
    instanceId:
      typeof source.instanceId === "string" && source.instanceId.trim()
        ? source.instanceId.trim()
        : DEFAULT_FIXTURE_SOURCE.instanceId,
    ...(Number.isInteger(source.pid) ? { pid: source.pid } : {}),
  };
}

function resolveAppServerStateDir(env) {
  return path.resolve(
    expandHome(env.RUNWEAVE_APP_SERVER_STATE_DIR) ??
      expandHome(env.RUNWEAVE_APP_SERVER_HOME) ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
}

function expandHome(value) {
  if (!value) {
    return null;
  }
  return value === "~" || value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
