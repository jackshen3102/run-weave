import type {
  DiagnosticLogRecord,
  DiagnosticLogResult,
  DiagnosticLogStatus,
} from "@runweave/shared";

import { requestJson } from "./http";
import type { SupportLogRecord } from "../features/support-logs";

function authHeaders(accessToken: string): { Authorization: string } {
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

/**
 * Map an App support-log record into the shared diagnostic-log shape so client
 * events can be uploaded and merged with backend logs server-side.
 */
export function toDiagnosticLogRecord(
  record: SupportLogRecord,
): DiagnosticLogRecord {
  return {
    at: record.at,
    source: `app:${record.level}`,
    message: record.event,
    details: record.fields,
  };
}

export interface DiagnosticLogStatusResponse {
  status: DiagnosticLogStatus;
  startedAt?: string | null;
}

export async function getDiagnosticLogStatus(
  apiBase: string,
  accessToken: string,
): Promise<DiagnosticLogStatusResponse> {
  return requestJson<DiagnosticLogStatusResponse>(
    apiBase,
    "/api/diagnostic-logs/status",
    {
      headers: authHeaders(accessToken),
    },
  );
}

export async function startDiagnosticLogs(
  apiBase: string,
  accessToken: string,
): Promise<DiagnosticLogStatusResponse> {
  return requestJson<DiagnosticLogStatusResponse>(
    apiBase,
    "/api/diagnostic-logs/start",
    {
      method: "POST",
      headers: authHeaders(accessToken),
    },
  );
}

export async function stopDiagnosticLogs(
  apiBase: string,
  accessToken: string,
  frontendLogs: DiagnosticLogRecord[],
): Promise<DiagnosticLogResult> {
  return requestJson<DiagnosticLogResult>(
    apiBase,
    "/api/diagnostic-logs/stop",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(accessToken),
      },
      body: JSON.stringify({ frontendLogs }),
    },
  );
}
