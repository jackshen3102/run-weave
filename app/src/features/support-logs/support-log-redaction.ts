import type {
  SupportLogRecord,
  SupportLogRedactionReport,
} from "./support-log-types";

const SENSITIVE_KEY_PATTERN =
  /token|password|secret|authorization|cookie|ticket/i;

function createReport(): SupportLogRedactionReport {
  return {
    tokens: 0,
    cookies: 0,
    authorizationHeaders: 0,
    sensitiveUrls: 0,
  };
}

function countSensitiveKey(key: string, report: SupportLogRedactionReport): void {
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes("authorization")) {
    report.authorizationHeaders += 1;
    return;
  }
  if (lowerKey.includes("cookie")) {
    report.cookies += 1;
    return;
  }
  report.tokens += 1;
}

function redactUrl(value: string, report: SupportLogRedactionReport): string {
  try {
    const url = new URL(value);
    if (url.search) {
      report.sensitiveUrls += 1;
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function redactValue(
  value: unknown,
  report: SupportLogRedactionReport,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, report));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        countSensitiveKey(key, report);
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactValue(nestedValue, report);
      }
    }
    return redacted;
  }
  if (typeof value === "string") {
    return redactUrl(value, report);
  }
  return value;
}

export function redactSupportLogs(records: SupportLogRecord[]): {
  logs: SupportLogRecord[];
  redactionReport: SupportLogRedactionReport;
} {
  const redactionReport = createReport();
  const logs = records.map((record) => ({
    ...record,
    fields: record.fields
      ? (redactValue(record.fields, redactionReport) as Record<string, unknown>)
      : undefined,
  }));

  return { logs, redactionReport };
}
