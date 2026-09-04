import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

type IncidentLevel = "info" | "warn" | "error";

interface DesktopIncidentLoggerOptions {
  appName: string;
  appVersion: string;
  isPackaged: boolean;
  logsPath: string;
  userDataPath: string;
  resourcesPath: string;
}

interface LogRecord {
  at: string;
  level: IncidentLevel;
  launchId: string;
  event: string;
  details?: Record<string, unknown>;
}

interface CrashReportSummary {
  file: string;
  copiedTo: string;
  mtimeMs: number;
  appName: string | null;
  timestamp: string | null;
  exceptionType: string | null;
  termination: string | null;
}

interface DiagnosticPackageOptions {
  snapshot?: Record<string, unknown>;
}

interface DiagnosticPackageResult {
  directory: string;
  summaryFile: string;
}

const MAX_COPIED_CRASH_REPORTS = 5;
const SENSITIVE_FIELD_PATTERN =
  /(password|passwd|token|secret|api[-_]?key|authorization|cookie)/i;

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "bigint") {
      return entry.toString();
    }
    if (entry instanceof Error) {
      return {
        name: entry.name,
        message: entry.message,
        stack: entry.stack,
      };
    }
    return entry;
  });
}

function redactDetails(value: unknown, key = ""): unknown {
  if (key && SENSITIVE_FIELD_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactDetails(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        redactDetails(entry, entryKey),
      ]),
    );
  }

  return value;
}

function toRecord(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  return redactDetails(details) as Record<string, unknown>;
}

function timestampForFile(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function parseCrashReportSummary(
  sourceFile: string,
  copiedTo: string,
): CrashReportSummary {
  const stat = statSync(sourceFile);
  const raw = readFileSync(sourceFile, "utf8");
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "{}";
  let header: Record<string, unknown> = {};
  try {
    header = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    header = {};
  }

  const exceptionType = raw.match(/"type"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const termination =
    raw.match(/"indicator"\s*:\s*"([^"]+)"/)?.[1] ??
    raw.match(/"termination"\s*:\s*\{[^}]*"namespace"\s*:\s*"([^"]+)"/)?.[1] ??
    null;

  return {
    file: sourceFile,
    copiedTo,
    mtimeMs: stat.mtimeMs,
    appName: typeof header.app_name === "string" ? header.app_name : null,
    timestamp: typeof header.timestamp === "string" ? header.timestamp : null,
    exceptionType,
    termination,
  };
}

export class DesktopIncidentLogger {
  readonly launchId = randomUUID();
  readonly logsDir: string;
  readonly mainLogPath: string;
  private readonly crashReportsDir: string;
  private readonly packagesDir: string;
  private readonly seenCrashReportsPath: string;

  constructor(private readonly options: DesktopIncidentLoggerOptions) {
    this.logsDir = path.join(options.logsPath, "desktop-incidents");
    this.mainLogPath = path.join(this.logsDir, "main.jsonl");
    this.crashReportsDir = path.join(this.logsDir, "crash-reports");
    this.packagesDir = path.join(this.logsDir, "packages");
    this.seenCrashReportsPath = path.join(this.logsDir, "seen-crash-reports.json");
    mkdirSync(this.crashReportsDir, { recursive: true });
    mkdirSync(this.packagesDir, { recursive: true });
  }

  info(event: string, details?: unknown): void {
    this.write("info", event, details);
  }

  warn(event: string, details?: unknown): void {
    this.write("warn", event, details);
  }

  error(event: string, details?: unknown): void {
    this.write("error", event, details);
  }

  recordLaunch(): void {
    this.info("desktop.launch", {
      appName: this.options.appName,
      appVersion: this.options.appVersion,
      isPackaged: this.options.isPackaged,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      userDataPath: this.options.userDataPath,
      logsPath: this.options.logsPath,
      resourcesPath: this.options.resourcesPath,
    });
  }

  recordNewCrashReports(): CrashReportSummary[] {
    const diagnosticReportsDir = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
    if (!existsSync(diagnosticReportsDir)) {
      return [];
    }

    const seen = this.readSeenCrashReports();
    const candidates = readdirSync(diagnosticReportsDir)
      .filter((name) => name.startsWith(this.options.appName) && name.endsWith(".ips"))
      .map((name) => path.join(diagnosticReportsDir, name))
      .filter((file) => {
        const stat = statSync(file);
        return seen[file] !== stat.mtimeMs;
      })
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
      .slice(0, MAX_COPIED_CRASH_REPORTS);

    const copied: CrashReportSummary[] = [];
    for (const sourceFile of candidates) {
      const stat = statSync(sourceFile);
      const targetFile = path.join(
        this.crashReportsDir,
        `${timestampForFile(stat.mtime)}-${path.basename(sourceFile)}`,
      );
      copyFileSync(sourceFile, targetFile);
      seen[sourceFile] = stat.mtimeMs;
      const summary = parseCrashReportSummary(sourceFile, targetFile);
      copied.push(summary);
      this.error("desktop.crashReport.captured", summary);
    }

    this.writeSeenCrashReports(seen);
    return copied;
  }

  exportDiagnosticPackage(
    options: DiagnosticPackageOptions = {},
  ): DiagnosticPackageResult {
    const directory = path.join(
      this.packagesDir,
      `desktop-diagnostics-${timestampForFile()}`,
    );
    mkdirSync(directory, { recursive: true });

    if (existsSync(this.mainLogPath)) {
      copyFileSync(this.mainLogPath, path.join(directory, "main.jsonl"));
    }

    const crashReportsTarget = path.join(directory, "crash-reports");
    mkdirSync(crashReportsTarget, { recursive: true });
    if (existsSync(this.crashReportsDir)) {
      for (const fileName of readdirSync(this.crashReportsDir)) {
        const source = path.join(this.crashReportsDir, fileName);
        if (statSync(source).isFile()) {
          copyFileSync(source, path.join(crashReportsTarget, fileName));
        }
      }
    }

    const summaryFile = path.join(directory, "summary.json");
    writeFileSync(
      summaryFile,
      `${JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          launchId: this.launchId,
          appName: this.options.appName,
          appVersion: this.options.appVersion,
          isPackaged: this.options.isPackaged,
          logsPath: this.options.logsPath,
          userDataPath: this.options.userDataPath,
          snapshot: redactDetails(options.snapshot ?? {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    this.info("desktop.diagnostics.exported", { directory });
    return { directory, summaryFile };
  }

  private write(level: IncidentLevel, event: string, details?: unknown): void {
    const record: LogRecord = {
      at: new Date().toISOString(),
      level,
      launchId: this.launchId,
      event,
      details: toRecord(details),
    };

    appendFileSync(this.mainLogPath, `${safeJson(record)}\n`, "utf8");
  }

  private readSeenCrashReports(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.seenCrashReportsPath, "utf8")) as Record<
        string,
        number
      >;
    } catch {
      return {};
    }
  }

  private writeSeenCrashReports(seen: Record<string, number>): void {
    writeFileSync(
      this.seenCrashReportsPath,
      `${JSON.stringify(seen, null, 2)}\n`,
      "utf8",
    );
  }
}
