import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiagnosticLogRecord, DiagnosticLogRedactionReport, DiagnosticLogResult, DiagnosticLogStatus } from "@runweave/shared/diagnostic-logs";

interface DiagnosticLogRecorderOptions {
  tempRoot?: string;
  persistRoot?: string;
  maxPersistedRuns?: number;
}

interface CreateAiDiagnosticLogOptions {
  recorder: DiagnosticLogRecorder;
  source: string;
  consoleLog?: (message: string, details?: Record<string, unknown>) => void;
}

interface RedactionState {
  report: DiagnosticLogRedactionReport;
}

const SENSITIVE_FIELD_PATTERN =
  /(password|passwd|token|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|ticket)/i;
const COOKIE_FIELD_PATTERN = /^cookie$/i;
const AUTHORIZATION_FIELD_PATTERN = /^authorization$/i;
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "auth",
  "code",
  "key",
  "password",
  "refresh_token",
  "secret",
  "ticket",
  "token",
]);

function createRedactionReport(): DiagnosticLogRedactionReport {
  return {
    authorizationHeaders: 0,
    cookies: 0,
    tokens: 0,
  };
}

function cloneLog(log: DiagnosticLogRecord): DiagnosticLogRecord {
  return {
    ...log,
    details: log.details ? { ...log.details } : undefined,
  };
}

function normalizeLog(log: DiagnosticLogRecord): DiagnosticLogRecord {
  return {
    at: typeof log.at === "string" ? log.at : new Date().toISOString(),
    source: typeof log.source === "string" ? log.source : undefined,
    message: typeof log.message === "string" ? log.message : String(log.message),
    details:
      log.details && typeof log.details === "object" && !Array.isArray(log.details)
        ? { ...log.details }
        : undefined,
  };
}

function redactUrlString(value: string, state: RedactionState): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (rawUrl) => {
    try {
      const parsedUrl = new URL(rawUrl);
      let changed = false;
      for (const key of Array.from(parsedUrl.searchParams.keys())) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
          parsedUrl.searchParams.set(key, "[REDACTED]");
          state.report.tokens += 1;
          changed = true;
        }
      }
      return changed ? parsedUrl.toString() : rawUrl;
    } catch {
      return rawUrl;
    }
  });
}

function redactString(value: string, state: RedactionState): string {
  const withHeaders = value
    .replace(/\bAuthorization\s*:\s*(Bearer|Basic)\s+[^\s,;]+/gi, (match) => {
      state.report.authorizationHeaders += 1;
      return match.replace(/(Bearer|Basic)\s+[^\s,;]+/i, "$1 [REDACTED]");
    })
    .replace(
      /\bCookie\s*:\s*([^\n,]+?)(?=\s+(?:request|https?:\/\/|Authorization\b)|$)/gi,
      () => {
      state.report.cookies += 1;
      return "Cookie: [REDACTED]";
      },
    );

  return redactUrlString(withHeaders, state);
}

function redactValue(
  value: unknown,
  state: RedactionState,
  currentKey?: string,
): unknown {
  if (currentKey && AUTHORIZATION_FIELD_PATTERN.test(currentKey)) {
    state.report.authorizationHeaders += 1;
    return "[REDACTED]";
  }

  if (currentKey && COOKIE_FIELD_PATTERN.test(currentKey)) {
    state.report.cookies += 1;
    return "[REDACTED]";
  }

  if (currentKey && SENSITIVE_FIELD_PATTERN.test(currentKey)) {
    state.report.tokens += 1;
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value, state);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, state));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactValue(entry, state, key),
      ]),
    );
  }

  return value;
}

function redactLogs(logs: DiagnosticLogRecord[]): {
  logs: DiagnosticLogRecord[];
  report: DiagnosticLogRedactionReport;
} {
  const state: RedactionState = {
    report: createRedactionReport(),
  };

  return {
    logs: logs.map((log) => ({
      ...log,
      message: redactString(log.message, state),
      details: log.details
        ? (redactValue(log.details, state) as Record<string, unknown>)
        : undefined,
    })),
    report: state.report,
  };
}

function toJsonl(logs: DiagnosticLogRecord[]): string {
  return logs.map((log) => JSON.stringify(log)).join("\n") + "\n";
}

export class DiagnosticLogRecorder {
  private readonly tempRoot: string;
  private persistRoot: string | null;
  private maxPersistedRuns: number;
  private readonly logs: DiagnosticLogRecord[] = [];
  private latestResult: DiagnosticLogResult | null = null;
  private startedAt: string | null = null;

  constructor(options: DiagnosticLogRecorderOptions = {}) {
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.persistRoot = options.persistRoot ?? null;
    this.maxPersistedRuns = Math.max(1, options.maxPersistedRuns ?? 20);
  }

  /**
   * Configure where stopped runs are persisted. Used at startup so the module
   * singleton (bound to the backend aiDiagnosticLog) writes into a stable,
   * discoverable directory instead of only the OS temp root.
   */
  configurePersistence(options: {
    persistRoot?: string;
    maxPersistedRuns?: number;
  }): void {
    if (options.persistRoot !== undefined) {
      this.persistRoot = options.persistRoot;
    }
    if (options.maxPersistedRuns !== undefined) {
      this.maxPersistedRuns = Math.max(1, options.maxPersistedRuns);
    }
  }

  getStatus(): DiagnosticLogStatus {
    if (this.startedAt) {
      return "recording";
    }

    return this.latestResult ? "ended" : "ready";
  }

  isRecording(): boolean {
    return Boolean(this.startedAt);
  }

  /** ISO timestamp of the in-progress recording, or null when not recording. */
  getStartedAt(): string | null {
    return this.startedAt;
  }

  start(): void {
    this.logs.length = 0;
    this.latestResult = null;
    this.startedAt = new Date().toISOString();
  }

  append(log: DiagnosticLogRecord): void {
    if (!this.isRecording()) {
      return;
    }

    this.logs.push(normalizeLog(log));
  }

  stop(frontendLogs: DiagnosticLogRecord[] = []): DiagnosticLogResult {
    // Idempotent stop: once a recording has ended, a repeated stop (e.g. the
    // client retrying after a persistence failure) must NOT rebuild an empty
    // result — that would clobber the real captured logs. Return the existing
    // result so the caller can safely retry persistence on the same data.
    if (!this.isRecording()) {
      if (this.latestResult) {
        return this.getResult() as DiagnosticLogResult;
      }
    }

    const startedAt = this.startedAt ?? new Date().toISOString();
    this.startedAt = null;
    const stoppedAt = new Date().toISOString();
    const mergedLogs = [
      ...this.logs.map(cloneLog),
      ...frontendLogs.map(normalizeLog),
    ].sort((left, right) => left.at.localeCompare(right.at));
    const redacted = redactLogs(mergedLogs);
    const result: DiagnosticLogResult = {
      startedAt,
      stoppedAt,
      logs: redacted.logs,
      redactionReport: redacted.report,
    };

    this.logs.length = 0;
    this.latestResult = result;
    return result;
  }

  getResult(): DiagnosticLogResult | null {
    if (!this.latestResult) {
      return null;
    }

    return {
      ...this.latestResult,
      logs: this.latestResult.logs.map(cloneLog),
      redactionReport: this.latestResult.redactionReport
        ? { ...this.latestResult.redactionReport }
        : undefined,
      files: this.latestResult.files ? { ...this.latestResult.files } : undefined,
    };
  }

  /**
   * Persist the latest result to a stable, discoverable directory so the logs
   * can be read and analyzed server-side without client-side file export.
   * Falls back to the temp root when no persist root is configured.
   */
  async persistLatestResult(): Promise<NonNullable<DiagnosticLogResult["files"]>> {
    if (!this.latestResult) {
      throw new Error("No diagnostic log result available");
    }

    const root = this.persistRoot ?? this.tempRoot;
    const baseDir = path.join(root, "diagnostic-logs");
    const dirName = `run-${this.latestResult.stoppedAt.replace(/[:.]/g, "-")}`;
    const runDir = path.join(baseDir, dirName);
    mkdirSync(runDir, { recursive: true });

    const logsJsonl = path.join(runDir, "logs.jsonl");
    const redactionReportJson = path.join(runDir, "redaction-report.json");
    await Promise.all([
      writeFile(logsJsonl, toJsonl(this.latestResult.logs), "utf8"),
      writeFile(
        redactionReportJson,
        `${JSON.stringify(this.latestResult.redactionReport ?? createRedactionReport(), null, 2)}\n`,
        "utf8",
      ),
    ]);

    this.prunePersistedRuns(baseDir);

    const files = { dir: runDir, logsJsonl, redactionReportJson };
    this.latestResult = { ...this.latestResult, files };
    return files;
  }

  /**
   * @deprecated Persistence now happens on stop via persistLatestResult. Kept
   * so the download route can lazily materialize files if they are missing.
   */
  async exportLatestResult(): Promise<NonNullable<DiagnosticLogResult["files"]>> {
    return this.persistLatestResult();
  }

  private prunePersistedRuns(baseDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(baseDir).filter((name) => name.startsWith("run-"));
    } catch {
      return;
    }

    if (entries.length <= this.maxPersistedRuns) {
      return;
    }

    const sorted = entries
      .map((name) => {
        const fullPath = path.join(baseDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { fullPath, mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);

    for (const { fullPath } of sorted.slice(
      0,
      sorted.length - this.maxPersistedRuns,
    )) {
      rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

export function createAiDiagnosticLog({
  recorder,
  source,
  consoleLog = console.log,
}: CreateAiDiagnosticLogOptions): (
  message: string,
  details?: Record<string, unknown>,
) => void {
  return (message, details) => {
    consoleLog(message, details);

    if (!recorder.isRecording()) {
      return;
    }

    recorder.append({
      at: new Date().toISOString(),
      source,
      message,
      details,
    });
  };
}

export const diagnosticLogRecorder = new DiagnosticLogRecorder();
export const aiDiagnosticLog = createAiDiagnosticLog({
  recorder: diagnosticLogRecorder,
  source: "backend",
});
