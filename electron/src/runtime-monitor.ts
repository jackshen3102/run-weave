import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";

export interface ElectronProcessMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  creationTime: number;
  cpu: {
    percentCPUUsage: number;
  };
  memory: {
    workingSetSize: number;
  };
}

export interface BackendUsage {
  cpu: number;
  memory: number;
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function kbToMb(value: number): number {
  return Math.round(value / 1024);
}

function bytesToMb(value: number): number {
  return Math.round(value / (1024 * 1024));
}

export function buildRuntimeStatsSnapshot(params: {
  sampledAt: number;
  processMetrics: ElectronProcessMetric[];
  backendPid: number | null;
  backendUsage: BackendUsage | null;
}): RuntimeStatsSnapshot {
  const processes = params.processMetrics.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name ?? null,
    serviceName: metric.serviceName ?? null,
    cpuPercent: roundToTwo(metric.cpu.percentCPUUsage),
    memoryMb: kbToMb(metric.memory.workingSetSize),
  }));

  const totalCpuPercent = roundToTwo(
    processes.reduce((sum, process) => sum + process.cpuPercent, 0),
  );
  const totalMemoryMb = processes.reduce(
    (sum, process) => sum + process.memoryMb,
    0,
  );

  return {
    sampledAt: params.sampledAt,
    electron: {
      totalCpuPercent,
      totalMemoryMb,
      processes,
    },
    backend:
      params.backendPid !== null && params.backendUsage
        ? {
            available: true,
            pid: params.backendPid,
            cpuPercent: roundToTwo(params.backendUsage.cpu),
            memoryMb: bytesToMb(params.backendUsage.memory),
          }
        : {
            available: false,
            pid: null,
            cpuPercent: null,
            memoryMb: null,
          },
  };
}
