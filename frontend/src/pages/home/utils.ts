import type { SessionListItem } from "@browser-viewer/shared";

export function formatDateTime(isoTime: string): string {
  return new Date(isoTime).toLocaleString();
}

export function getProxyStatusLabel(proxyEnabled: boolean): string {
  return proxyEnabled ? "Proxy enabled" : "Proxy disabled";
}

export function getSessionSourceLabel(
  sourceType: SessionListItem["sourceType"],
): string {
  return sourceType === "connect-cdp" ? "Attach Browser" : "New Browser";
}

export function getHeaderSummaryLabel(headers: SessionListItem["headers"]): string {
  const headerCount = Object.keys(headers).length;
  if (headerCount === 0) {
    return "No custom headers";
  }

  return `${headerCount} header${headerCount === 1 ? "" : "s"}`;
}

export function parseSessionHeaders(input: string): Record<string, string> {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    return {};
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(trimmedInput);
  } catch {
    throw new Error("Request headers must be valid JSON.");
  }

  if (
    !parsedValue ||
    typeof parsedValue !== "object" ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("Request headers must be a JSON object.");
  }

  return Object.entries(parsedValue).reduce<Record<string, string>>(
    (result, [key, value]) => {
      if (typeof value !== "string") {
        throw new Error("Request headers must use string values.");
      }

      result[key] = value;
      return result;
    },
    {},
  );
}
