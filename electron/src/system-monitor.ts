import { execFile } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  SystemMonitorAppGroup,
  SystemMonitorMemoryPressure,
  SystemMonitorSnapshot,
} from "@browser-viewer/shared";

interface CpuTimesSnapshot {
  busy: number;
  idle: number;
}

interface AppIdentity {
  appKey: string;
  appName: string;
}

interface RawSystemMonitorProcess {
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

const COMMAND_TIMEOUT_MS = 2_000;
const TOP_APP_COUNT = 50;
const TOP_PROCESS_COUNT = 100;

let previousCpuTimes: CpuTimesSnapshot[] | null = null;

function roundToOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function bytesToMb(value: number): number {
  return Math.round(value / (1024 * 1024));
}

function kbToMb(value: number): number {
  return roundToOne(value / 1024);
}

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function basenameWithoutAppSuffix(value: string): string {
  return path.basename(value).replace(/\.app$/i, "");
}

function hashAppKey(value: string): string {
  return `app:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function resolveExecutableName(command: string): string {
  const executable = command.trim().split(/\s+/)[0] ?? command.trim();
  return path.basename(executable) || command.trim();
}

function resolveAppIdentity(command: string): AppIdentity {
  const appMatch = command.match(/(\/.*?\.app)(?:\/|\s|$)/);
  if (appMatch?.[1]) {
    return {
      appKey: appMatch[1],
      appName: basenameWithoutAppSuffix(appMatch[1]),
    };
  }

  const executable = command.trim().split(/\s+/)[0] ?? command.trim();
  const appName = basenameWithoutAppSuffix(executable) || command.trim();
  return {
    appKey: appName,
    appName,
  };
}

export function parsePsOutput(
  output: string,
  currentProcessIds: ReadonlySet<number>,
): RawSystemMonitorProcess[] {
  const processes: RawSystemMonitorProcess[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+?)\s*$/,
    );
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuPercent = Number(match[3]);
    const rssKb = Number(match[4]);
    const command = match[5]?.trim() ?? "";
    if (!Number.isFinite(pid) || !command) {
      continue;
    }

    const identity = resolveAppIdentity(command);
    const executableName = resolveExecutableName(command);
    processes.push({
      pid,
      ppid,
      displayName: executableName,
      executableName,
      cpuPercent: roundToOne(Number.isFinite(cpuPercent) ? cpuPercent : 0),
      memoryMb: kbToMb(Number.isFinite(rssKb) ? rssKb : 0),
      appKey: hashAppKey(identity.appKey),
      appName: identity.appName,
      isCurrentApp: currentProcessIds.has(pid),
    });
  }

  return processes;
}

function aggregateByApp(
  processes: RawSystemMonitorProcess[],
): SystemMonitorAppGroup[] {
  const groups = new Map<string, SystemMonitorAppGroup>();

  for (const process of processes) {
    const existing = groups.get(process.appKey);
    if (existing) {
      existing.processCount += 1;
      existing.cpuPercent = roundToOne(
        existing.cpuPercent + process.cpuPercent,
      );
      existing.memoryMb = roundToOne(existing.memoryMb + process.memoryMb);
      existing.pids.push(process.pid);
      existing.isCurrentApp = existing.isCurrentApp || process.isCurrentApp;
      continue;
    }

    groups.set(process.appKey, {
      appKey: process.appKey,
      appName: process.appName,
      processCount: 1,
      cpuPercent: process.cpuPercent,
      memoryMb: process.memoryMb,
      pids: [process.pid],
      isCurrentApp: process.isCurrentApp,
    });
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    cpuPercent: roundToOne(group.cpuPercent),
    memoryMb: roundToOne(group.memoryMb),
    pids: group.pids.sort((a, b) => a - b),
  }));
}

function takeTopUnion<T>(
  items: T[],
  limit: number,
  getKey: (item: T) => string | number,
  sorters: Array<(a: T, b: T) => number>,
): T[] {
  const selected = new Map<string | number, T>();

  for (const sorter of sorters) {
    for (const item of [...items].sort(sorter).slice(0, limit)) {
      selected.set(getKey(item), item);
    }
  }

  return Array.from(selected.values());
}

function sortAppByCpu(a: SystemMonitorAppGroup, b: SystemMonitorAppGroup) {
  return b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb;
}

function sortAppByMemory(a: SystemMonitorAppGroup, b: SystemMonitorAppGroup) {
  return b.memoryMb - a.memoryMb || b.cpuPercent - a.cpuPercent;
}

function sortProcessByCpu(
  a: RawSystemMonitorProcess,
  b: RawSystemMonitorProcess,
) {
  return b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb;
}

function sortProcessByMemory(
  a: RawSystemMonitorProcess,
  b: RawSystemMonitorProcess,
) {
  return b.memoryMb - a.memoryMb || b.cpuPercent - a.cpuPercent;
}

function sampleSystemCpu(): SystemMonitorSnapshot["cpu"] {
  const cpus = os.cpus();
  const current = cpus.map((cpu) => {
    const busy =
      cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
    return {
      busy,
      idle: cpu.times.idle,
    };
  });

  if (!previousCpuTimes || previousCpuTimes.length !== current.length) {
    previousCpuTimes = current;
    return {
      totalPercent: null,
      coreCount: current.length,
      warmingUp: true,
    };
  }

  let busyDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < current.length; index += 1) {
    const prev = previousCpuTimes[index];
    const next = current[index];
    if (!prev || !next) {
      continue;
    }
    const coreBusyDelta = Math.max(0, next.busy - prev.busy);
    const coreIdleDelta = Math.max(0, next.idle - prev.idle);
    busyDelta += coreBusyDelta;
    totalDelta += coreBusyDelta + coreIdleDelta;
  }

  previousCpuTimes = current;

  return {
    totalPercent:
      totalDelta > 0 ? roundToOne((busyDelta / totalDelta) * 100) : null,
    coreCount: current.length,
    warmingUp: false,
  };
}

export function parseSwapUsage(output: string | null): number {
  const usedMatch = output?.match(/used\s*=\s*([0-9.]+)([KMG])/i);
  if (!usedMatch?.[1] || !usedMatch[2]) {
    return 0;
  }

  const value = Number(usedMatch[1]);
  if (!Number.isFinite(value)) {
    return 0;
  }

  const unit = usedMatch[2].toUpperCase();
  if (unit === "G") {
    return roundToOne(value * 1024);
  }
  if (unit === "K") {
    return roundToOne(value / 1024);
  }
  return roundToOne(value);
}

export function parseMemoryPressure(
  output: string | null,
): SystemMonitorMemoryPressure {
  if (!output) {
    return "unknown";
  }

  if (/critical/i.test(output)) {
    return "critical";
  }
  if (/\bwarn(?:ing)?\b/i.test(output)) {
    return "warn";
  }
  if (/\bnormal\b/i.test(output)) {
    return "normal";
  }

  const freePercentMatch = output.match(
    /System-wide memory free percentage:\s*(\d+)%/i,
  );
  const freePercent = freePercentMatch?.[1]
    ? Number(freePercentMatch[1])
    : null;
  if (freePercent === null || !Number.isFinite(freePercent)) {
    return "unknown";
  }
  if (freePercent <= 5) {
    return "critical";
  }
  if (freePercent <= 15) {
    return "warn";
  }
  return "normal";
}

export function parseVmStatUsedMb(
  output: string | null,
  fallbackUsedMb: number,
): number {
  if (!output) {
    return fallbackUsedMb;
  }

  const pageSizeMatch = output.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch?.[1] ? Number(pageSizeMatch[1]) : null;
  if (!pageSize || !Number.isFinite(pageSize)) {
    return fallbackUsedMb;
  }

  const readPageCount = (label: string): number => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`${escaped}:\\s+(\\d+)\\.`, "i"));
    const value = match?.[1] ? Number(match[1]) : 0;
    return Number.isFinite(value) ? value : 0;
  };

  const usedPages =
    readPageCount("Pages active") +
    readPageCount("Pages wired down") +
    readPageCount("Pages occupied by compressor");

  return usedPages > 0 ? bytesToMb(usedPages * pageSize) : fallbackUsedMb;
}

export function parseBattery(
  pmsetOutput: string | null,
  ioregOutput: string | null,
): SystemMonitorSnapshot["battery"] {
  if (!pmsetOutput || !/InternalBattery/i.test(pmsetOutput)) {
    return { available: false };
  }

  const percentMatch = pmsetOutput.match(/(\d+)%/);
  const percent = percentMatch?.[1] ? Number(percentMatch[1]) : null;
  if (percent === null || !Number.isFinite(percent)) {
    return { available: false };
  }

  const charging =
    /AC Power/i.test(pmsetOutput) || /;\s*charging;/i.test(pmsetOutput);
  const timeMatch = pmsetOutput.match(/(\d+):(\d+)\s+remaining/i);
  const timeRemainingMin =
    timeMatch?.[1] && timeMatch[2]
      ? Number(timeMatch[1]) * 60 + Number(timeMatch[2])
      : null;
  const amperageMatch = ioregOutput?.match(/"InstantAmperage"\s*=\s*(-?\d+)/);
  const dischargeRateMa = amperageMatch?.[1] ? Number(amperageMatch[1]) : null;

  return {
    available: true,
    percent,
    charging,
    timeRemainingMin,
    dischargeRateMa:
      dischargeRateMa !== null && Number.isFinite(dischargeRateMa)
        ? dischargeRateMa
        : null,
  };
}

async function sampleProcesses(
  currentProcessIds: ReadonlySet<number>,
): Promise<RawSystemMonitorProcess[]> {
  const output = await runCommand("ps", ["-axo", "pid,ppid,pcpu,rss,command"]);
  return output ? parsePsOutput(output, currentProcessIds) : [];
}

export async function buildSystemMonitorSnapshot(
  params: {
    currentProcessIds?: number[];
  } = {},
): Promise<SystemMonitorSnapshot> {
  if (process.platform !== "darwin") {
    return {
      sampledAt: Date.now(),
      platform: "other",
      cpu: {
        totalPercent: null,
        coreCount: os.cpus().length,
        warmingUp: false,
      },
      memory: {
        totalMb: bytesToMb(os.totalmem()),
        usedMb: bytesToMb(os.totalmem() - os.freemem()),
        pressure: "unknown",
        swapUsedMb: 0,
      },
      battery: { available: false },
      apps: [],
      processes: [],
    };
  }

  const currentProcessIds = new Set(params.currentProcessIds ?? []);
  const [
    processes,
    vmStatOutput,
    memoryPressureOutput,
    swapOutput,
    pmsetOutput,
    ioregOutput,
  ] = await Promise.all([
    sampleProcesses(currentProcessIds),
    runCommand("vm_stat", []),
    runCommand("memory_pressure", []),
    runCommand("sysctl", ["-n", "vm.swapusage"]),
    runCommand("pmset", ["-g", "batt"]),
    runCommand("ioreg", ["-r", "-n", "AppleSmartBattery"]),
  ]);

  const apps = takeTopUnion(
    aggregateByApp(processes),
    TOP_APP_COUNT,
    (appGroup) => appGroup.appKey,
    [sortAppByCpu, sortAppByMemory],
  );

  const topProcesses = takeTopUnion(
    processes,
    TOP_PROCESS_COUNT,
    (process) => process.pid,
    [sortProcessByCpu, sortProcessByMemory],
  );

  return {
    sampledAt: Date.now(),
    platform: "darwin",
    cpu: sampleSystemCpu(),
    memory: {
      totalMb: bytesToMb(os.totalmem()),
      usedMb: parseVmStatUsedMb(
        vmStatOutput,
        bytesToMb(os.totalmem() - os.freemem()),
      ),
      pressure: parseMemoryPressure(memoryPressureOutput),
      swapUsedMb: parseSwapUsage(swapOutput),
    },
    battery: parseBattery(pmsetOutput, ioregOutput),
    apps,
    processes: topProcesses,
  };
}
