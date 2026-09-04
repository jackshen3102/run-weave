export const WORKSPACE_SERVICE_CONFIG_FILE_NAME = "runweave.json";

export type WorkspaceServiceStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export type WorkspaceServiceConfigStatus = "missing" | "valid" | "invalid";

export type WorkspaceServiceErrorCode =
  | "config_invalid"
  | "config_changed"
  | "context_unavailable"
  | "context_deleting"
  | "service_not_found"
  | "start_blocked"
  | "port_unavailable"
  | "startup_timeout"
  | "process_exited"
  | "proxy_unavailable"
  | "local_request_required";

export interface WorkspaceServiceError {
  code: WorkspaceServiceErrorCode;
  message: string;
}

export interface WorkspaceServiceConfigState {
  status: WorkspaceServiceConfigStatus;
  revision: string | null;
  error: WorkspaceServiceError | null;
}

export interface WorkspaceServiceSnapshot {
  name: string;
  command: string;
  cwd: string;
  healthCheckPath: string | null;
  status: WorkspaceServiceStatus;
  url: string;
  targetPort: number | null;
  configRevision: string;
  staleConfig: boolean;
  exitCode: number | null;
  error: WorkspaceServiceError | null;
}

export interface WorkspaceServiceListResponse {
  parentProjectId: string;
  projectId: string;
  config: WorkspaceServiceConfigState;
  services: WorkspaceServiceSnapshot[];
}

export interface StartWorkspaceServiceRequest {
  configRevision: string;
}

export interface WorkspaceServiceMutationResponse {
  accepted: boolean;
  service: WorkspaceServiceSnapshot;
}
