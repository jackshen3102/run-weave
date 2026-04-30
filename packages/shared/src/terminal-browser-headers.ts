export const TERMINAL_BROWSER_HEADER_RULE_LIMIT = 20;
export const TERMINAL_BROWSER_DEFAULT_HEADER_URL_PATTERN = "*://*/*";

export type TerminalBrowserHeaderOperation = "set";

export interface TerminalBrowserHeaderRule {
  id: string;
  enabled: boolean;
  operation: TerminalBrowserHeaderOperation;
  name: string;
  value: string;
  urlPattern: string;
}

export interface TerminalBrowserHeaderState {
  rules: TerminalBrowserHeaderRule[];
}

export type TerminalBrowserHeaderRuleField =
  | "id"
  | "enabled"
  | "operation"
  | "name"
  | "value"
  | "urlPattern";

export interface TerminalBrowserHeaderRuleValidationResult {
  rule: TerminalBrowserHeaderRule | null;
  fieldErrors: Partial<Record<TerminalBrowserHeaderRuleField, string>>;
}

const BLOCKED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "connection",
  "upgrade",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function isBlockedTerminalBrowserHeaderName(name: string): boolean {
  return BLOCKED_HEADER_NAMES.has(name.trim().toLowerCase());
}

export function validateTerminalBrowserHeaderRule(
  value: unknown,
): TerminalBrowserHeaderRuleValidationResult {
  const fieldErrors: Partial<Record<TerminalBrowserHeaderRuleField, string>> =
    {};
  if (!value || typeof value !== "object") {
    return {
      rule: null,
      fieldErrors: { id: "Header rule must be an object." },
    };
  }

  const candidate = value as Partial<
    Record<TerminalBrowserHeaderRuleField, unknown>
  >;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const valueText = typeof candidate.value === "string" ? candidate.value : "";
  const urlPattern =
    typeof candidate.urlPattern === "string"
      ? candidate.urlPattern.trim()
      : TERMINAL_BROWSER_DEFAULT_HEADER_URL_PATTERN;

  if (!id) {
    fieldErrors.id = "Header rule id is required.";
  }
  if (typeof candidate.enabled !== "boolean") {
    fieldErrors.enabled = "Header rule enabled state must be a boolean.";
  }
  if (candidate.operation !== "set") {
    fieldErrors.operation = "Header rule operation must be SET.";
  }
  if (!name) {
    fieldErrors.name = "Header name is required.";
  } else if (name.includes(":") || hasControlCharacter(name)) {
    fieldErrors.name =
      "Header name cannot contain control characters or colon.";
  } else if (!HEADER_NAME_PATTERN.test(name)) {
    fieldErrors.name = "Header name contains invalid characters.";
  } else if (isBlockedTerminalBrowserHeaderName(name)) {
    fieldErrors.name = "This header name is not supported.";
  }
  if (!valueText.trim()) {
    fieldErrors.value = "Header value is required.";
  } else if (hasControlCharacter(valueText)) {
    fieldErrors.value = "Header value cannot contain control characters.";
  }
  if (!urlPattern) {
    fieldErrors.urlPattern = "URL pattern is required.";
  } else if (hasControlCharacter(urlPattern)) {
    fieldErrors.urlPattern = "URL pattern cannot contain control characters.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { rule: null, fieldErrors };
  }

  return {
    rule: {
      id,
      enabled: candidate.enabled as boolean,
      operation: "set",
      name,
      value: valueText,
      urlPattern,
    },
    fieldErrors,
  };
}

export function normalizeTerminalBrowserHeaderRules(
  value: unknown,
): TerminalBrowserHeaderRule[] {
  if (!Array.isArray(value)) {
    throw new Error("Header rules must be an array.");
  }
  if (value.length > TERMINAL_BROWSER_HEADER_RULE_LIMIT) {
    throw new Error(
      `Header rules are limited to ${TERMINAL_BROWSER_HEADER_RULE_LIMIT}.`,
    );
  }

  return value.map((rule, index) => {
    const result = validateTerminalBrowserHeaderRule(rule);
    if (!result.rule) {
      const [message] = Object.values(result.fieldErrors);
      throw new Error(message ?? `Header rule ${index + 1} is invalid.`);
    }
    return result.rule;
  });
}
