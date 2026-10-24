import type { DiagnosticLogRecord } from "@runweave/shared/diagnostic-logs";
import { runtimeBuildInfo } from "@runweave/shared/runtime-version";

export type DiagnosticAction = "terminal_send" | "suiji_save" | "browser_open" | "connection_recover" | "analytics";
export type DiagnosticStage = "started" | "request_started" | "response_received" | "confirmed" | "state_updated" | "ui_updated" | "loaded" | "rejected" | "failed" | "unknown" | "cancelled";
const key = "runweave.action-diagnostics.v1";
const limit = 256;
const byteLimit = 256 * 1024;
const records: DiagnosticLogRecord[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceFailed = false;
let emit: ((event: string) => void) | undefined;
export const diagnosticLaunchId = crypto.randomUUID();

export function setActionDiagnosticEmitter(next: (event: string) => void): void { emit = next; }

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const stored = localStorage.getItem(key);
    if (!stored || stored.length > byteLimit) return;
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(-limit)) {
        if (item && typeof item === "object" && item.source === "frontend:action" &&
          typeof item.at === "string" && typeof item.message === "string" && item.details &&
          typeof item.details === "object") records.push(item as DiagnosticLogRecord);
      }
    }
  } catch { persistenceFailed = true; }
}

function persist(): void {
  saveTimer = undefined;
  try {
    let serialized = JSON.stringify(records);
    while (serialized.length > byteLimit && records.length) {
      records.shift(); serialized = JSON.stringify(records);
    }
    localStorage.setItem(key, serialized);
    persistenceFailed = false;
  } catch { persistenceFailed = true; }
}

export function actionDiagnosticSnapshot(): DiagnosticLogRecord[] {
  load();
  if (saveTimer !== undefined) { clearTimeout(saveTimer); persist(); }
  return records.map(record => ({ ...record, details: { ...record.details } }));
}

export function actionDiagnosticPersistenceFailed(): boolean { return persistenceFailed; }

// Only fixed action names, generated IDs, numeric status and build metadata enter this ring.
// Never pass text, URLs, request bodies, server error messages or attachment names.
export function beginDiagnosticAction(action: DiagnosticAction, operationId?: string) {
  const id = operationId && /^[a-f0-9-]{36}$/i.test(operationId) ? operationId : crypto.randomUUID();
  const started = performance.now();
  const info = runtimeBuildInfo();
  const context = {
    operationId: id, launchId: diagnosticLaunchId,
    client: window.electronAPI?.isElectron ? "desktop" : "web",
    environment: import.meta.env.DEV ? "development" : import.meta.env.VITE_RUNWEAVE_CHANNEL === "beta" ? "beta" : "production",
    app_version: info.version, build_id: info.buildId ?? "unknown", source_revision: info.sourceRevision ?? "unknown",
  };
  function stage(stage: DiagnosticStage, error?: unknown, relatedOperationId?: string): void {
    // Collection/storage failures must not change the user's operation or trigger retries.
    try {
      load();
      const status = error && typeof error === "object" && "status" in error &&
        typeof error.status === "number" ? error.status : undefined;
      const code = error && typeof error === "object" && "code" in error &&
        typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
      const related = relatedOperationId && /^[a-f0-9-]{36}$/i.test(relatedOperationId) ? relatedOperationId : undefined;
      records.push({ at: new Date().toISOString(), source: "frontend:action", message: action,
        details: { ...context, stage, elapsedMs: Math.round(performance.now() - started), ...(status === undefined ? {} : { status }), ...(code ? { failureCode: code } : {}), ...(related ? { relatedOperationId: related } : {}) } });
      if (records.length > limit) records.splice(0, records.length - limit);
      if (saveTimer === undefined) saveTimer = setTimeout(persist, 500);
      if (action !== "analytics") emit?.(`action_${action}_${stage}`);
    } catch { /* Diagnostic collection is best effort. */ }
  }
  stage("started");
  return { id, stage };
}

window.addEventListener("pagehide", () => {
  if (saveTimer !== undefined) { clearTimeout(saveTimer); persist(); }
});
