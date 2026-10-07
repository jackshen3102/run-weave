export type DevResourceState = "free" | "busy" | "blocked" | "unknown";
export type DevResourceAction = "stop-and-release" | "release-occupancy";
export type DevResourceSourceState =
  | "ready"
  | "partial"
  | "unavailable"
  | "unsupported";

export interface DevResource {
  id: string;
  kind: "desktop-slot" | "desktop-session" | "simulator";
  label: string;
  state: DevResourceState;
  owner: null | {
    id: string;
    task: string | null;
    worktree: string | null;
    startedAt: string | null;
    lastActivityAt: string | null;
  };
  ownershipVersion: string | null;
  details: {
    path: string | null;
    udid: string | null;
    deviceState: string | null;
    ports: number[];
    processes: Array<{
      name: string;
      pid: number;
      ownership: "owned" | "shared" | "unknown";
      cpuPercent: number | null;
      rssBytes: number | null;
    }>;
  };
  release: { action: DevResourceAction | null; disabledReason: string | null };
  operation: null | { id: string; state: "running" | "unknown" };
  reason: string | null;
}

export interface DevResourceGroup {
  sourceState: DevResourceSourceState;
  reason: string | null;
  resources: DevResource[];
  counts: Record<
    "total" | "busy" | "free" | "blocked" | "unknown",
    number | null
  >;
}

export interface DevResourcesSnapshot {
  protocolVersion: 1;
  observedAt: string;
  hostId: string;
  hostName: string;
  backendGeneration: string;
  desktop: DevResourceGroup & { sessions: DevResource[] };
  simulators: DevResourceGroup;
}

export interface ReleaseDevResourceRequest {
  action: DevResourceAction;
  expectedOwnershipVersion: string;
  idempotencyKey: string;
}

export interface ReleaseDevResourceResult {
  operationId: string;
  state: "released" | "blocked" | "running" | "unknown";
  message: string;
}
