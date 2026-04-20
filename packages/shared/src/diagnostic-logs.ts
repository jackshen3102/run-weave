export interface DiagnosticLogRecord {
  at: string;
  source?: string;
  message: string;
  details?: Record<string, unknown>;
}

export type DiagnosticLogStatus = "ready" | "recording" | "ended";

export interface DiagnosticLogResult {
  startedAt: string;
  stoppedAt: string;
  logs: DiagnosticLogRecord[];
  redactionReport?: DiagnosticLogRedactionReport;
  files?: {
    logsJsonl?: string;
    redactionReportJson?: string;
  };
}

export interface DiagnosticLogRedactionReport {
  tokens: number;
  cookies: number;
  authorizationHeaders: number;
}

export interface DiagnosticLogStopRequest {
  frontendLogs?: DiagnosticLogRecord[];
}
