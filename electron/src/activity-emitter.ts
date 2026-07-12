import { net } from "electron";
import crypto from "node:crypto";
import type {
  ActivityBatchWriteResponse,
  ActivityEventInput,
  ActivityEventName,
  ActivityPayload,
} from "@runweave/shared/activity";
import { desktopChannel, desktopSourceRevision } from "./desktop-config.js";
import { desktopRuntime } from "./desktop-runtime-state.js";
import { resolvePackagedBackendAuthEnv } from "./packaged-backend-auth.js";

const bootId = crypto.randomUUID();
const bootStartedAt = new Date().toISOString();
const navigationIds = new Map<string, string>();
let sequence = 0;
let accessToken: string | null = null;

function backendUrl(): string | null {
  const value =
    desktopRuntime.packagedBackendState.backendUrl ||
    process.env.RUNWEAVE_BACKEND_URL ||
    process.env.BROWSER_VIEWER_BACKEND_URL;
  return value?.trim().replace(/\/+$/, "") || null;
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

async function login(baseUrl: string): Promise<string> {
  const auth = resolvePackagedBackendAuthEnv(process.env);
  const response = await net.fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-auth-client": "electron" },
    body: JSON.stringify({ username: auth.AUTH_USERNAME, password: auth.AUTH_PASSWORD }),
  });
  if (!response.ok) throw new Error(`activity_electron_login_failed:${response.status}`);
  const payload = (await response.json()) as { accessToken?: string };
  if (!payload.accessToken) throw new Error("activity_electron_login_incomplete");
  accessToken = payload.accessToken;
  return payload.accessToken;
}

async function postEvent(event: ActivityEventInput): Promise<void> {
  const baseUrl = backendUrl();
  if (!baseUrl) return;
  let token = accessToken ?? (await login(baseUrl));
  let response = await net.fetch(`${baseUrl}/api/activity/electron-events/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [event] }),
  });
  if (response.status === 401) {
    accessToken = null;
    token = await login(baseUrl);
    response = await net.fetch(`${baseUrl}/api/activity/electron-events/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [event] }),
    });
  }
  if (!response.ok) throw new Error(`activity_electron_record_failed:${response.status}`);
  const result = (await response.json()) as ActivityBatchWriteResponse;
  if (result.acknowledgements[0]?.status === "rejected") {
    throw new Error(result.acknowledgements[0].code ?? "activity_electron_rejected");
  }
}

function record(params: {
  eventName: ActivityEventName;
  tabId: string;
  browserGroupId: string;
  operationId?: string;
  payload?: ActivityPayload;
  result?: ActivityEventInput["result"];
}): void {
  const now = new Date().toISOString();
  const event: ActivityEventInput = {
    eventId: crypto.randomUUID(),
    eventName: params.eventName,
    schemaVersion: 1,
    occurredAt: now,
    producer: {
      name: "runweave-electron",
      version: process.versions.electron,
      instanceId: process.env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() || `desktop:${process.pid}`,
      bootId,
      bootStartedAt,
      sequence: ++sequence,
    },
    actor: { type: "user" },
    runtime: {
      channel: desktopChannel,
      surface: "desktop",
      appVersion: process.env.npm_package_version,
      sourceRevision: desktopSourceRevision,
    },
    scope: {
      browserGroupId: params.browserGroupId,
      tabId: params.tabId,
      ...(params.operationId ? { operationId: params.operationId } : {}),
    },
    ...(params.result ? { result: params.result } : {}),
    payload: params.payload ?? {},
    contents: [],
    externalRefs: [],
  };
  void postEvent(event).catch((error) => {
    desktopRuntime.incidentLogger?.warn("activity.electron.record.failed", {
      eventName: params.eventName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function recordBrowserTabEvent(params: {
  eventName: "browser.tab.created" | "browser.tab.activated" | "browser.tab.closed";
  tabId: string;
  browserGroupId: string;
  reason: string;
}): void {
  record({ ...params, payload: { reason: params.reason } });
}

export function recordBrowserNavigationStarted(params: {
  tabId: string;
  browserGroupId: string;
  url: string;
}): void {
  const operationId = crypto.randomUUID();
  navigationIds.set(params.tabId, operationId);
  record({
    eventName: "browser.navigation.started",
    ...params,
    operationId,
    payload: { to: sanitizeUrl(params.url) },
  });
}

export function recordBrowserNavigationFinished(params: {
  tabId: string;
  browserGroupId: string;
  url: string;
  status: "completed" | "failed" | "cancelled";
  code?: string;
}): void {
  const operationId = navigationIds.get(params.tabId) ?? crypto.randomUUID();
  navigationIds.delete(params.tabId);
  record({
    eventName: `browser.navigation.${params.status}`,
    tabId: params.tabId,
    browserGroupId: params.browserGroupId,
    operationId,
    payload: { to: sanitizeUrl(params.url) },
    result: {
      status: params.status === "completed" ? "succeeded" : "failed",
      ...(params.code ? { code: params.code } : {}),
    },
  });
}
