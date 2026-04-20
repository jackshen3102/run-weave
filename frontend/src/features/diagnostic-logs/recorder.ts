import type {
  DiagnosticLogRecord,
  DiagnosticLogResult,
  DiagnosticLogStatus,
} from "@browser-viewer/shared";

interface CreateAiDiagnosticLogOptions {
  recorder: FrontendDiagnosticLogRecorder;
  source: string;
  consoleLog?: (message: string, details?: Record<string, unknown>) => void;
}

function cloneLog(log: DiagnosticLogRecord): DiagnosticLogRecord {
  return {
    ...log,
    details: log.details ? { ...log.details } : undefined,
  };
}

export class FrontendDiagnosticLogRecorder {
  private readonly bufferedLogs: DiagnosticLogRecord[] = [];
  private result: DiagnosticLogResult | null = null;
  private status: DiagnosticLogStatus = "ready";

  getStatus(): DiagnosticLogStatus {
    return this.status;
  }

  isRecording(): boolean {
    return this.status === "recording";
  }

  start(): void {
    this.bufferedLogs.length = 0;
    this.result = null;
    this.status = "recording";
  }

  append(log: DiagnosticLogRecord): void {
    if (!this.isRecording()) {
      return;
    }

    this.bufferedLogs.push(cloneLog(log));
  }

  getBufferedLogs(): DiagnosticLogRecord[] {
    return this.bufferedLogs.map(cloneLog);
  }

  finish(result: DiagnosticLogResult): void {
    this.bufferedLogs.length = 0;
    this.result = {
      ...result,
      logs: result.logs.map(cloneLog),
      redactionReport: result.redactionReport
        ? { ...result.redactionReport }
        : undefined,
      files: result.files ? { ...result.files } : undefined,
    };
    this.status = "ended";
  }

  setStatus(status: DiagnosticLogStatus): void {
    this.status = status;
  }

  setResult(result: DiagnosticLogResult | null): void {
    this.result = result
      ? {
          ...result,
          logs: result.logs.map(cloneLog),
          redactionReport: result.redactionReport
            ? { ...result.redactionReport }
            : undefined,
          files: result.files ? { ...result.files } : undefined,
        }
      : null;
    this.status = result ? "ended" : "ready";
  }

  getResult(): DiagnosticLogResult | null {
    if (!this.result) {
      return null;
    }

    return {
      ...this.result,
      logs: this.result.logs.map(cloneLog),
      redactionReport: this.result.redactionReport
        ? { ...this.result.redactionReport }
        : undefined,
      files: this.result.files ? { ...this.result.files } : undefined,
    };
  }

  clear(): void {
    this.bufferedLogs.length = 0;
    this.result = null;
    this.status = "ready";
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

export function formatDiagnosticLogResult(
  result: DiagnosticLogResult | null,
): string {
  if (!result) {
    return "";
  }

  return result.logs
    .map((log) => {
      const source = log.source ? ` [${log.source}]` : "";
      const details = log.details ? ` ${JSON.stringify(log.details)}` : "";
      return `${log.at}${source} ${log.message}${details}`;
    })
    .join("\n");
}

export const frontendDiagnosticLogRecorder =
  new FrontendDiagnosticLogRecorder();

export const aiDiagnosticLog = createAiDiagnosticLog({
  recorder: frontendDiagnosticLogRecorder,
  source: "frontend",
});
