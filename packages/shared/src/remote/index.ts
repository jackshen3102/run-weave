import { isTerminalBrowserProfileId, type ResolvedTerminalBrowserProfile } from "../browser/profile";

export interface ResourceRef {
  connectionId: string;
  id: string;
}

export interface RemoteServiceRef {
  endpointId: string;
  parentProjectId: string;
  projectId: string;
  serviceId: string;
}

export interface ResolvedServiceAccess {
  ref: RemoteServiceRef;
  desktopUrl: string;
  generation: number;
}

export interface RemoteCapabilities {
  protocolVersion: number;
  installationId: string;
  serviceInstanceId: string;
  capabilities: {
    terminal: boolean;
    files: boolean;
    events: boolean;
    workspaceServices: boolean;
    desktopBrowser: boolean;
  };
}

export interface DesktopBrowserBindingRequest {
  protocolVersion: 2;
  desktopId: string;
  hostId: string;
  generation: number;
  reversePort: number;
  gatewayKey: string;
}

export interface DesktopBrowserBinding {
  protocolVersion: 2;
  id: string;
  desktopId: string;
  hostId: string;
  generation: number;
}

export interface RemoteBrowserResolveRequest {
  projectId: string;
  explicitProfileId: "profile-1" | "profile-2" | "profile-3" | null;
  browserGroupId: string | null;
}

export type RemoteBrowserProfileState = Pick<ResolvedTerminalBrowserProfile, "profileId" | "source" | "route" | "whistle">;

export function isRemoteBrowserProfileState<T>(value: T): value is T & RemoteBrowserProfileState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RemoteBrowserProfileState>;
  const whistle = state.whistle;
  const route = state.route;
  return isTerminalBrowserProfileId(state.profileId) &&
    ["explicit", "worktree", "global-default"].includes(state.source ?? "") &&
    !!route && (route.kind === "unassigned" ||
      (route.kind === "dev-server" && Number.isInteger(route.port) && route.port > 0 && route.port <= 65535)) &&
    !!whistle && whistle.profileId === state.profileId &&
    ["stopped", "starting", "ready", "failed"].includes(whistle.status) &&
    whistle.host === "127.0.0.1" && Number.isInteger(whistle.port) && whistle.port > 0 && whistle.port <= 65535 &&
    typeof whistle.storage === "string" &&
    (whistle.pid === null || (Number.isInteger(whistle.pid) && whistle.pid > 0)) &&
    (whistle.error === null || (typeof whistle.error === "object" &&
      typeof whistle.error.code === "string" && typeof whistle.error.message === "string"));
}

export interface RemoteBrowserGatewayResponse extends RemoteBrowserProfileState {
  ticket: string;
  browserGroupId: string;
}

export interface RemoteBrowserResolveResponse extends RemoteBrowserProfileState {
  protocolVersion: 2;
  binding: DesktopBrowserBinding;
  browserGroupId: string;
  cdpEndpoint: string;
  expiresIn: number;
}
