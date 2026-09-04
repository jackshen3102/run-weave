import type {
  WorkspaceServiceSnapshot,
  WorkspaceServiceStatus,
} from "@runweave/shared/terminal/workspace-service";
import type { WorkspaceServiceDefinition } from "./config";
import type { WorkspaceServiceIdentity } from "./identity";
import type { OwnedWorkspaceServiceProcess } from "./owned-process";

export interface WorkspaceServiceRecord {
  identity: WorkspaceServiceIdentity;
  parentProjectId: string;
  projectId: string;
  definition: WorkspaceServiceDefinition;
  configRevision: string;
  status: WorkspaceServiceStatus;
  targetPort: number | null;
  process: OwnedWorkspaceServiceProcess | null;
  readinessAbort: AbortController | null;
  generation: number;
  exitCode: number | null;
  error: WorkspaceServiceSnapshot["error"];
}

export interface WorkspaceServiceProxyRoute {
  known: boolean;
  status: WorkspaceServiceStatus;
  targetPort: number | null;
}
