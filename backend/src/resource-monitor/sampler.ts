import { fileURLToPath } from "node:url";
import { ResourceCounters } from "./counters";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { signedBatteryCurrent } from "@runweave/shared/battery";
import type { DeviceBattery } from "@runweave/shared/device-status";
import type {
  SystemMonitorAppGroup,
  SystemMonitorProcess,
  SystemMonitorSnapshot,
} from "@runweave/shared/system-monitor";

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  uid: number;
  started: string;
  executable: string;
  processInstanceId: string;
  sampledAt: number;
  actionKind: "terminate" | "stop_service" | "readonly";
  actionReason?: string;
}
export interface ResourceSample {
  snapshot: SystemMonitorSnapshot;
  identities: Map<string, ProcessIdentity>;
  processListComplete?: boolean;
  coverage: {
    knownProcesses: number;
    matchedProcesses: number;
    complete: boolean;
  };
}
export function runCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        signal,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
const round = (value: number) => Math.round(value * 10) / 10;
export function parseIdentities(
  output: string,
  sampledAt = Date.now(),
): Map<string, ProcessIdentity> {
  const identities = new Map<string, ProcessIdentity>();
  for (const line of output.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(.+?)\s*$/.exec(
        line,
      );
    if (!match) continue;
    const [, pid, ppid, uid, started, , executable] = match;
    const processInstanceId = hash(`${pid}:${uid}:${started}:${executable}`);
    identities.set(processInstanceId, {
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      started: started!,
      executable: executable!,
      processInstanceId,
      sampledAt,
      actionKind: "readonly",
    });
  }
  return identities;
}
export async function readIdentity(
  pid: number,
  signal: AbortSignal,
): Promise<ProcessIdentity | null> {
  // ps exit 1 means no selected PID; all other failures must remain errors.
  try {
    const output = await runCommand(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "pid=,ppid=,uid=,lstart=,rss=,comm="],
      signal,
    );
    const result = [...parseIdentities(output).values()];
    if (result.length !== 1) throw new Error("无法核对进程身份");
    return result[0]!;
  } catch (error) {
    if ((error as { code?: unknown; stdout?: string }).code === 1) {
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") return null;
      }
    }
    throw error;
  }
}
export function protectionReason(
  identity: ProcessIdentity,
  protectedPids: ReadonlySet<number>,
): string | undefined {
  if (identity.pid <= 1 || identity.uid !== process.getuid?.())
    return "系统或其他用户进程";
  if (
    protectedPids.has(identity.pid) ||
    /\/Runweave[^/]*\.app\//i.test(identity.executable)
  )
    return "Runweave 控制进程";
  if (/^\/(System|usr\/libexec|usr\/sbin|sbin)\//.test(identity.executable))
    return "系统进程";
  if (
    !identity.executable.startsWith("/") ||
    /[\r\n]/.test(identity.executable)
  )
    return "无法可靠核对身份";
  return undefined;
}
export function createResourceSampler(helperPath?: string) {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const binary =
    helperPath ??
    (path.basename(moduleDirectory) === "resource-monitor"
      ? path.resolve(
          moduleDirectory,
          "../../.native-artifacts/resource-sampler",
        )
      : path.join(moduleDirectory, "resource-sampler"));
  const counters = new ResourceCounters();
  return async function sampleResources(
    signal: AbortSignal,
    battery: DeviceBattery | null,
  ): Promise<ResourceSample> {
    const ps = await runCommand(
      "/bin/ps",
      ["-ww", "-axo", "pid,ppid,uid,lstart,rss,comm"],
      signal,
    );
    const sampledAt = Date.now();
    const all = parseIdentities(ps, sampledAt);
    const protectedPids = new Set<number>([process.pid]);
    // Protect the Backend's ancestors and descendants, including its control plane.
    let parent = process.ppid;
    while (parent > 1 && !protectedPids.has(parent)) {
      protectedPids.add(parent);
      parent = [...all.values()].find((p) => p.pid === parent)?.ppid ?? 0;
    }
    const descendants = new Set<number>([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of all.values())
        if (descendants.has(p.ppid) && !descendants.has(p.pid)) {
          protectedPids.add(p.pid);
          descendants.add(p.pid);
          changed = true;
        }
    }
    const [counterOutput, vm, pressure, swap, batteryPlist] = await Promise.all(
      [
        runCommand(binary, [], signal),
        runCommand("/usr/bin/vm_stat", [], signal).catch(() => ""),
        runCommand(
          "/usr/sbin/sysctl",
          ["-n", "kern.memorystatus_vm_pressure_level"],
          signal,
        ).catch(() => ""),
        runCommand("/usr/sbin/sysctl", ["-n", "vm.swapusage"], signal).catch(
          () => "",
        ),
        runCommand(
          "/usr/sbin/ioreg",
          ["-a", "-r", "-n", "AppleSmartBattery"],
          signal,
        ).catch(() => ""),
      ],
    );
    const { scores, truncated, cpu } = counters.read(counterOutput);
    const rss = new Map<number, number>();
    for (const line of ps.split("\n")) {
      const match =
        /^\s*(\d+)\s+\d+\s+\d+\s+\w{3}\s+\w{3}\s+\d+\s+\S+\s+\d{4}\s+(\d+)/.exec(
          line,
        );
      if (match) rss.set(Number(match[1]), Number(match[2]) / 1024);
    }
    const processes: SystemMonitorProcess[] = [];
    const apps = new Map<string, SystemMonitorAppGroup>();
    let matched = 0;
    for (const identity of [...all.values()].slice(0, 4096)) {
      const simulator = identity.executable.match(
        /\/Profiles\/Runtimes\/([^/]+)\.simruntime\//,
      )?.[1];
      const appPath = identity.executable.match(/(\/.*?\.app)(?:\/|$)/)?.[1];
      const name = path.basename(identity.executable);
      const appName = simulator
        ? `${simulator} Simulator`
        : appPath
          ? path.basename(appPath, ".app")
          : name;
      const appKey = `app:${hash(simulator ?? appPath ?? name)}`;
      const score = scores.get(identity.pid);
      if (score) matched++;
      const reason = protectionReason(identity, protectedPids);
      identity.actionKind = reason ? "readonly" : "terminate";
      identity.actionReason = reason;
      const item: SystemMonitorProcess = {
        pid: identity.pid,
        ppid: identity.ppid,
        processInstanceId: identity.processInstanceId,
        displayName: name,
        executableName: name,
        appKey,
        appName,
        cpuPercent: score?.cpu ?? null,
        energyImpact: score?.power ?? null,
        memoryMb: round(rss.get(identity.pid) ?? 0),
        coverage: score ? "complete" : "partial",
        isCurrentApp: protectedPids.has(identity.pid),
        actionKind: identity.actionKind,
        actionReason: reason,
      };
      processes.push(item);
      const group = apps.get(appKey) ?? {
        appKey,
        appName,
        processCount: 0,
        cpuPercent: 0,
        memoryMb: 0,
        energyImpact: 0,
        coverage: "complete",
        pids: [],
        isCurrentApp: false,
      };
      group.processCount++;
      group.cpuPercent = round(
        (group.cpuPercent ?? 0) + (item.cpuPercent ?? 0),
      );
      group.memoryMb = round(group.memoryMb + item.memoryMb);
      group.energyImpact = round(
        (group.energyImpact ?? 0) + (item.energyImpact ?? 0),
      );
      group.pids.push(item.pid);
      group.isCurrentApp ||= item.isCurrentApp;
      if (!score) group.coverage = "partial";
      apps.set(appKey, group);
    }
    for (const group of apps.values())
      if (group.coverage === "partial") {
        group.energyImpact = null;
        group.cpuPercent = null;
      }
    const readInteger = (key: string) =>
      batteryPlist.match(
        new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`),
      )?.[1] ?? null;
    const current = signedBatteryCurrent(readInteger("InstantAmperage"));
    const voltage = Number(readInteger("Voltage"));
    const dischargePowerW =
      battery?.powerSource === "battery" &&
      battery.chargeState === "discharging" &&
      current !== null &&
      current < 0 &&
      voltage > 0 &&
      voltage < 30_000
        ? round((voltage * Math.abs(current)) / 1_000_000)
        : null;
    const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] ?? 0);
    const pages = [
      "Pages active",
      "Pages wired down",
      "Pages occupied by compressor",
    ].reduce(
      (sum, label) =>
        sum + Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0),
      0,
    );
    const swapMatch = swap.match(/used\s*=\s*([\d.]+)([KMG])/);
    const complete = !truncated && all.size <= 4096 && matched === all.size;
    return {
      identities: new Map([...all].slice(0, 4096)),
      processListComplete: all.size <= 4096,
      coverage: {
        knownProcesses: all.size,
        matchedProcesses: matched,
        complete,
      },
      snapshot: {
        sampledAt: Date.now(),
        platform: "darwin",
        cpu,
        memory: {
          totalMb: Math.round(os.totalmem() / 1048576),
          usedMb: Math.round(
            pageSize && pages
              ? (pageSize * pages) / 1048576
              : (os.totalmem() - os.freemem()) / 1048576,
          ),
          pressure:
            ({ "1": "normal", "2": "warn", "4": "critical" } as const)[
              pressure.trim() as "1" | "2" | "4"
            ] ?? "unknown",
          swapUsedMb: swapMatch
            ? round(
                Number(swapMatch[1]) *
                  (swapMatch[2] === "G"
                    ? 1024
                    : swapMatch[2] === "K"
                      ? 1 / 1024
                      : 1),
              )
            : 0,
        },
        battery:
          battery?.presence === "present" && battery.percent !== null
            ? {
                available: true,
                percent: battery.percent,
                charging: battery.powerSource === "ac",
                powerSource: battery.powerSource,
                timeRemainingMin: battery.remainingMinutes,
                dischargeRateMa: current,
                dischargePowerW,
              }
            : { available: false },
        apps: [...apps.values()],
        processes,
      },
    };
  };
}
export const sampleResources = createResourceSampler();
