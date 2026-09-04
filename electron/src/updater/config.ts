import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LOCAL_UPDATE_BASE_URL =
  "http://127.0.0.1:5500/updates/mac/";

export function shouldEnableAutoUpdates(params: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return params.isPackaged && params.platform === "darwin";
}

export function getCustomUpdateBaseUrl(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const candidate = trimmed;
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}

export function getPackagedUpdateBaseUrl(
  resourcesPath: string | undefined,
): string | null {
  if (!resourcesPath) {
    return null;
  }

  try {
    const raw = fs.readFileSync(
      path.join(resourcesPath, "app-update.yml"),
      "utf8",
    );
    const match = raw.match(
      /(?:^|\n)\s*url:\s*['"]?([^'"\n]+)['"]?\s*(?:\n|$)/,
    );
    return getCustomUpdateBaseUrl(match?.[1]);
  } catch {
    return null;
  }
}

export function isLocalUpdateBaseUrl(value: string | null): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function shouldAutoInstallLocalUpdates(params: {
  explicitValue: string | undefined;
  updateBaseUrl: string | null;
}): boolean {
  const explicit = params.explicitValue?.trim().toLowerCase();

  if (explicit) {
    return ["1", "true", "yes", "on"].includes(explicit);
  }

  return isLocalUpdateBaseUrl(params.updateBaseUrl);
}
