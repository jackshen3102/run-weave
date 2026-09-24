export interface ResourceRef {
  connectionId: string;
  id: string;
}

export interface ProjectBinding {
  connectionId: string;
  remoteProjectId: string;
  remoteDirectory: string;
}

export type ConnectionRuntimeStatus =
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "needs_auth"
  | "incompatible"
  | "failed";

export interface ConnectionRuntime {
  connectionId: string;
  generation: number;
  installationId: string | null;
  serviceInstanceId: string | null;
  apiBase: string | null;
  status: ConnectionRuntimeStatus;
  lastObservedAt: string | null;
  message: string | null;
  browserAvailable?: boolean;
  browserMessage?: string | null;
  agents?: RemoteCapabilities["agents"];
}

export interface SshRemoteConnection {
  connectionId: string;
  host: string;
  backendPort: number;
  browserProfileId: "profile-1" | "profile-2" | "profile-3" | null;
  approvedBrowserGroupId?: string | null;
}

export interface RemoteServiceRef {
  connectionId: string;
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
  agents?: Array<{
    kind: "pi" | "codex";
    state: "ready" | "missing_cli" | "needs_configuration" | "needs_auth";
    version: string | null;
    provider: string | null;
    model: string | null;
  }>;
}

export interface DesktopBrowserBindingRequest {
  connectionId: string;
  generation: number;
  reversePort: number;
  gatewayKey: string;
}

export interface DesktopBrowserBinding {
  id: string;
  connectionId: string;
  generation: number;
}

export interface RemoteBrowserResolveRequest {
  projectId: string;
  explicitProfileId: "profile-1" | "profile-2" | "profile-3" | null;
  browserGroupId: string | null;
}

export interface RemoteBrowserResolveResponse {
  profileId: "profile-1" | "profile-2" | "profile-3";
  browserGroupId: string;
  cdpEndpoint: string;
  expiresIn: number;
}

export interface ManualRemotePortAccess {
  connectionId: string;
  remotePort: number;
  desktopUrl: string;
  generation: number;
}
