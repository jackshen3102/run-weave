import type { PackagedBackendConnectionState } from "@browser-viewer/shared";

function normalizeBackendUrl(backendUrl: string): string {
  return backendUrl.trim().replace(/\/+$/, "");
}

export function createAvailablePackagedBackendState(
  backendUrl: string,
  options?: {
    runtimeSource?: PackagedBackendConnectionState["runtimeSource"];
    runtimeReleaseId?: string | null;
    statusMessage?: string | null;
  },
): PackagedBackendConnectionState {
  return {
    kind: "packaged-local",
    available: true,
    backendUrl: normalizeBackendUrl(backendUrl),
    statusMessage: options?.statusMessage ?? null,
    canReconnect: true,
    runtimeSource: options?.runtimeSource ?? null,
    runtimeReleaseId: options?.runtimeReleaseId ?? null,
  };
}

export function createUnavailablePackagedBackendStateFromExit(
  backendUrl: string,
  event: {
    code: number | null;
    signal: string | null;
  },
): PackagedBackendConnectionState {
  return {
    kind: "packaged-local",
    available: false,
    backendUrl: normalizeBackendUrl(backendUrl),
    statusMessage: `内置本地后端已停止 (code=${event.code ?? "none"}, signal=${event.signal ?? "none"})`,
    canReconnect: true,
    runtimeSource: null,
    runtimeReleaseId: null,
  };
}

export function createUnavailablePackagedBackendStateFromError(
  backendUrl: string,
  error: unknown,
): PackagedBackendConnectionState {
  return {
    kind: "packaged-local",
    available: false,
    backendUrl: normalizeBackendUrl(backendUrl),
    statusMessage: `内置本地后端不可用: ${String(error)}`,
    canReconnect: true,
    runtimeSource: null,
    runtimeReleaseId: null,
  };
}
