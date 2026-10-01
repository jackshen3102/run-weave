export type SystemMonitorPlatform = "darwin" | "other";

export type SystemMonitorMemoryPressure =
  | "normal"
  | "warn"
  | "critical"
  | "unknown";

export interface SystemMonitorProcess {
  processInstanceId?: string;
  actionKind?: "terminate" | "stop_service" | "readonly";
  actionReason?: string;
  serviceName?: string;
  pid: number;
  ppid: number;
  displayName: string;
  executableName: string;
  cpuPercent: number | null;
  memoryMb: number;
  appKey: string;
  appName: string;
  isCurrentApp: boolean;
  energyImpact?: number | null;
  coverage?: "complete" | "partial";
}

export interface SystemMonitorAppGroup {
  appKey: string;
  appName: string;
  processCount: number;
  cpuPercent: number | null;
  memoryMb: number;
  pids: number[];
  isCurrentApp: boolean;
  energyImpact?: number | null;
  coverage?: "complete" | "partial";
}

export interface SystemMonitorSnapshot {
  sampledAt: number;
  platform: SystemMonitorPlatform;
  cpu: {
    totalPercent: number | null;
    coreCount: number;
    warmingUp: boolean;
  };
  memory: {
    totalMb: number;
    usedMb: number;
    pressure: SystemMonitorMemoryPressure;
    swapUsedMb: number;
  };
  battery:
    | { available: false }
    | {
        available: true;
        percent: number;
        charging: boolean;
        timeRemainingMin: number | null;
        dischargeRateMa: number | null;
        powerSource?: "battery" | "ac" | "unknown";
        dischargePowerW?: number | null;
      };
  apps: SystemMonitorAppGroup[];
  processes: SystemMonitorProcess[];
}
