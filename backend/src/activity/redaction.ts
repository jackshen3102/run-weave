import type {
  ActivityPayload,
  ActivityPayloadValue,
} from "@runweave/shared/activity";

export const ACTIVITY_REDACTION_VERSION = "activity-redaction-v1";

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|environment|env)$/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|rk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:authorization|cookie|password|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactActivityText(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

function redactValue(value: ActivityPayloadValue): ActivityPayloadValue {
  if (typeof value === "string") {
    return redactActivityText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child),
      ]),
    );
  }
  return value;
}

export function redactActivityPayload(payload: ActivityPayload): ActivityPayload {
  return redactValue(payload) as ActivityPayload;
}

export function sanitizeActivityLocator(locator: string): string {
  try {
    const url = new URL(locator);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return redactActivityText(url.toString());
  } catch {
    return redactActivityText(locator);
  }
}
