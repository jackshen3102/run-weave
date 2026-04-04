export const DEFAULT_LOCAL_UPDATE_BASE_URL = "http://127.0.0.1:5500/updates/mac/";

export function shouldEnableAutoUpdates(params: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return params.isPackaged && params.platform === "darwin";
}

export function getCustomUpdateBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const candidate = trimmed;
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
}
