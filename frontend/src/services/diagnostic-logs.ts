import type {
  DiagnosticLogRecord,
  DiagnosticLogResult,
  DiagnosticLogStatus,
} from "@browser-viewer/shared";
import { requestBlob, requestJson } from "./http";

function authHeaders(token: string): { Authorization: string } {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function getDiagnosticLogStatus(
  apiBase: string,
  token: string,
): Promise<{ status: DiagnosticLogStatus }> {
  return requestJson<{ status: DiagnosticLogStatus }>(
    apiBase,
    "/api/diagnostic-logs/status",
    {
      headers: authHeaders(token),
    },
  );
}

export async function startDiagnosticLogs(
  apiBase: string,
  token: string,
): Promise<{ status: DiagnosticLogStatus }> {
  return requestJson<{ status: DiagnosticLogStatus }>(
    apiBase,
    "/api/diagnostic-logs/start",
    {
      method: "POST",
      headers: authHeaders(token),
    },
  );
}

export async function stopDiagnosticLogs(
  apiBase: string,
  token: string,
  frontendLogs: DiagnosticLogRecord[],
): Promise<DiagnosticLogResult> {
  return requestJson<DiagnosticLogResult>(
    apiBase,
    "/api/diagnostic-logs/stop",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ frontendLogs }),
    },
  );
}

export async function getDiagnosticLogResult(
  apiBase: string,
  token: string,
): Promise<DiagnosticLogResult | null> {
  return requestJson<DiagnosticLogResult | null>(
    apiBase,
    "/api/diagnostic-logs/result",
    {
      headers: authHeaders(token),
    },
  );
}

export async function downloadDiagnosticLogs(
  apiBase: string,
  token: string,
): Promise<Blob> {
  return requestBlob(apiBase, "/api/diagnostic-logs/download", {
    method: "POST",
    headers: authHeaders(token),
  });
}
