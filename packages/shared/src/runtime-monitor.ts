export interface RuntimeProcessSnapshot {
  pid: number;
  type: string;
  name: string | null;
  serviceName: string | null;
  cpuPercent: number;
  memoryMb: number;
}

export interface RuntimeStatsSnapshot {
  sampledAt: number;
  electron: {
    totalCpuPercent: number;
    totalMemoryMb: number;
    processes: RuntimeProcessSnapshot[];
  };
  backend: {
    available: boolean;
    pid: number | null;
    cpuPercent: number | null;
    memoryMb: number | null;
  };
}

export interface PackagedBackendConnectionState {
  kind: "packaged-local";
  available: boolean;
  backendUrl: string;
  statusMessage: string | null;
  canReconnect: boolean;
}
