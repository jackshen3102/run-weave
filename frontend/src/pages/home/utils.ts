import {
  validateBrowserProfile,
  type BrowserProfile,
  type SessionListItem,
} from "@browser-viewer/shared";

interface BrowserProfileInput {
  localeInput: string;
  timezoneIdInput: string;
  userAgentInput: string;
  viewportWidthInput: string;
  viewportHeightInput: string;
}

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

function parseViewportDimension(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

export function parseBrowserProfileInput(
  input: BrowserProfileInput,
): BrowserProfile | undefined {
  const locale = input.localeInput.trim();
  const timezoneId = input.timezoneIdInput.trim();
  const userAgent = input.userAgentInput.trim();
  const viewportWidth = input.viewportWidthInput.trim();
  const viewportHeight = input.viewportHeightInput.trim();

  if (Boolean(viewportWidth) !== Boolean(viewportHeight)) {
    throw new Error("Viewport width and height must be provided together.");
  }

  const profile: BrowserProfile = {};
  if (locale) {
    profile.locale = locale;
  }
  if (timezoneId) {
    profile.timezoneId = timezoneId;
  }
  if (userAgent) {
    profile.userAgent = userAgent;
  }
  if (viewportWidth && viewportHeight) {
    profile.viewport = {
      width: parseViewportDimension("Viewport width", viewportWidth),
      height: parseViewportDimension("Viewport height", viewportHeight),
    };
  }

  const validation = validateBrowserProfile(
    Object.keys(profile).length > 0 ? profile : undefined,
  );
  const firstFieldError = Object.values(validation.fieldErrors)[0];
  if (firstFieldError) {
    throw new Error(firstFieldError);
  }

  return validation.normalizedProfile;
}
