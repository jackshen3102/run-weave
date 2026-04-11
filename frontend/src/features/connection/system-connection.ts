import type { PackagedBackendConnectionState } from "@browser-viewer/shared";
import type { ConnectionConfig } from "./types";

export const LOCAL_DEV_CONNECTION_ID = "system:local-development";

export function shouldExposeLocalDevelopmentConnection(
  isElectron: boolean,
  managesPackagedBackend: boolean,
): boolean {
  return isElectron && managesPackagedBackend;
}

export function buildLocalDevelopmentConnection(
  state: PackagedBackendConnectionState | null,
): ConnectionConfig | null {
  if (!state) {
    return null;
  }

  return {
    id: LOCAL_DEV_CONNECTION_ID,
    name: "本地开发",
    url: state.backendUrl.trim().replace(/\/+$/, ""),
    createdAt: 0,
    available: state.available,
    statusMessage: state.statusMessage,
    canReconnect: state.canReconnect,
    isSystem: true,
    canEdit: false,
    canDelete: false,
  };
}

export function resolveNeedsConnection(
  isElectron: boolean,
  activeConnection: ConnectionConfig | null,
): boolean {
  if (!isElectron) {
    return false;
  }

  return (
    !activeConnection ||
    !activeConnection.url ||
    activeConnection.available === false
  );
}

export function shouldShowReconnectAction(
  connection: ConnectionConfig,
): boolean {
  return connection.available === false && connection.canReconnect === true;
}
