export type SystemMonitorPlatform = "darwin" | "other";

export type SystemMonitorMemoryPressure =
  | "normal"
  | "warn"
  | "critical"
  | "unknown";

export interface SystemMonitorProcess {
  pid: number;
  ppid: number;
  displayName: string;
  executableName: string;
  cpuPercent: number;
  memoryMb: number;
  appKey: string;
  appName: string;
  isCurrentApp: boolean;
}

export interface SystemMonitorAppGroup {
  appKey: string;
  appName: string;
  processCount: number;
  cpuPercent: number;
  memoryMb: number;
  pids: number[];
  isCurrentApp: boolean;
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
      };
  apps: SystemMonitorAppGroup[];
  processes: SystemMonitorProcess[];
}
