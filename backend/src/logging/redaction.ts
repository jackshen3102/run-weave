const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|set-cookie|password|passwd|secret|token|credential|api[-_]?key)/i;
const URL_SECRET_PARAM_PATTERN =
  /([?&](?:token|access_token|refresh_token|auth|authorization|password|secret|api_key|apiKey)=)[^&#\s]+/gi;
const HEADER_SECRET_PATTERN =
  /\b(authorization|cookie|set-cookie):\s*[^\n\r]+/gi;
const ENV_SECRET_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION|API_KEY)[A-Z0-9_]*)=([^\s]+)/g;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function redactString(value: string): string {
  return value
    .replace(URL_SECRET_PARAM_PATTERN, "$1[redacted]")
    .replace(HEADER_SECRET_PATTERN, "$1: [redacted]")
    .replace(ENV_SECRET_PATTERN, "$1=[redacted]");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[max-depth]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[redacted]"
      : redactValue(entry, depth + 1);
  }
  return redacted;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const maybeCode = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: redactString(error.message),
      ...(error.stack ? { stack: redactString(error.stack) } : {}),
      ...(typeof maybeCode === "string" || typeof maybeCode === "number"
        ? { code: maybeCode }
        : {}),
    };
  }

  return {
    name: "Error",
    message: redactString(String(error)),
  };
}
