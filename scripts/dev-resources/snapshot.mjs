import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inspectBetaPool } from "../dev-session/beta-pool/projection.mjs";
import {
  readManifest,
  resolveDevSessionRoot,
} from "../dev-session/registry.mjs";
import { inspectSessionServices } from "../dev-session/services/index.mjs";
import {
  processIdentityMatches,
  isProcessLive,
} from "../dev-session/services/runtime.mjs";
import { readProcessGroupSnapshot } from "../dev-session/services/process-stop.mjs";
import {
  ownershipVersion,
  sessionIdentity,
  slotIdentity,
} from "./identity.mjs";

const exec = promisify(execFile);
export const pythonEntry = fileURLToPath(
  new URL("../ios-simulators/monitor.py", import.meta.url),
);
export const unavailable = (reason, sourceState = "unavailable") => ({
  sourceState,
  reason,
  resources: [],
  counts: { total: null, busy: null, free: null, blocked: null, unknown: null },
});

export function group(resources, reason = null) {
  const counts = {
    total: resources.length,
    busy: 0,
    free: 0,
    blocked: 0,
    unknown: 0,
  };
  for (const resource of resources) counts[resource.state]++;
  return {
    resources,
    counts,
    sourceState: reason || counts.unknown ? "partial" : "ready",
    reason,
  };
}

export function emptyResource(id, kind, label) {
  return {
    id,
    kind,
    label,
    state: "unknown",
    owner: null,
    ownershipVersion: null,
    details: {
      path: null,
      udid: null,
      deviceState: null,
      ports: [],
      processes: [],
    },
    release: { action: null, disabledReason: "无法确认资源归属" },
    operation: null,
    reason: null,
  };
}

export function protectsBackend(manifest, backendPid) {
  return Object.values(manifest?.services ?? {}).some(
    (service) =>
      service?.ownership === "dedicated" &&
      [service?.pid, service?.process?.pid].includes(backendPid),
  );
}

function manifestDetails(manifest) {
  const processes = new Map();
  const ports = new Set();
  for (const [name, service] of Object.entries(manifest.services)) {
    if (!service || name === "cdp" || service.ownership === "disabled")
      continue;
    const pid = service.process?.pid ?? service.pid;
    if (Number.isInteger(pid) && pid > 1 && isProcessLive(pid)) {
      const ownership =
        service.ownership === "shared-declared"
          ? "shared"
          : processIdentityMatches(service.process)
            ? "owned"
            : "unknown";
      if (!processes.has(pid))
        processes.set(pid, {
          name,
          pid,
          ownership,
          cpuPercent: null,
          rssBytes: null,
        });
    }
    if (service.url) {
      try {
        const port = Number(new URL(service.url).port);
        if (port > 0) ports.add(port);
      } catch {
        /* A non-HTTP surface has no port. */
      }
    }
  }
  return {
    path: manifest.source.root,
    udid: null,
    deviceState: null,
    ports: [...ports],
    processes: [...processes.values()],
  };
}

function manifestOwner(manifest) {
  return {
    id: manifest.devSessionId,
    task: manifest.controlPlane?.agentTeamRunId ?? manifest.profile,
    worktree: path.basename(manifest.source.root),
    startedAt: manifest.createdAt ?? null,
    lastActivityAt: null,
  };
}

async function inspectSessions(generation, backendPid) {
  const root = resolveDevSessionRoot();
  let entries;
  try {
    if ((await fs.lstat(root)).isSymbolicLink())
      throw new Error("Session registry 不允许符号链接");
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { resources: [], reason: null };
    return { resources: [], reason: "Session registry 无法读取" };
  }
  const resources = [];
  // Share one process-table observation, including failures, only within this read.
  // Hundreds of stopped manifests otherwise each trigger several full-machine ps calls.
  let processGroupsRead;
  let reason =
    entries.length > 2048
      ? "Session registry 超过扫描上限，部分状态未知"
      : null;
  for (const entry of entries.slice(0, 2048)) {
    if (entry.name.startsWith(".")) continue;
    try {
      const manifestPath = path.join(root, entry.name, "manifest.json");
      const stat = await fs.lstat(manifestPath);
      if (
        !entry.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.size > 1024 * 1024
      )
        throw new Error("不安全的 manifest");
      const manifest = await readManifest(entry.name);
      // Pool Sessions are represented by their physical slot, including orphan leases.
      if (manifest.targetEnvironment?.betaSlot?.assignedSlotId) continue;
      if (!["electron", "beta"].includes(manifest.profile)) continue;
      const released =
        manifest.state === "stopped" ||
        (manifest.state === "failed" &&
          manifest.failure?.leaseRetained === false);
      const processGroups = await (processGroupsRead ??= Promise.resolve().then(
        readProcessGroupSnapshot,
      ));
      const hasResidual = Object.values(manifest.services).some((service) => {
        if (service?.ownership !== "dedicated" || !service.process?.pid)
          return false;
        if (!Number.isInteger(service.process.pid) || service.process.pid <= 1)
          throw new Error("不安全的进程组 ID");
        return (
          isProcessLive(service.process.pid) ||
          (processGroups.get(service.process.pid)?.length ?? 0) > 0
        );
      });
      if (released && !hasResidual) continue;
      const inspection = await inspectSessionServices(manifest.services);
      const resource = emptyResource(
        `session:${manifest.devSessionId}`,
        "desktop-session",
        manifest.devSessionId,
      );
      resource.owner = manifestOwner(manifest);
      resource.details = manifestDetails(manifest);
      resource.ownershipVersion = ownershipVersion(
        generation,
        sessionIdentity(manifest),
      );
      resource.state = inspection.stale || released ? "blocked" : "busy";
      const safe = resource.details.processes.every(
        (item) => item.ownership !== "unknown",
      );
      resource.reason =
        resource.state === "blocked" ? "Session 存在未确认释放的资源" : null;
      const current = protectsBackend(manifest, backendPid);
      const transitional = ["planned", "starting", "stopping"].includes(
        manifest.state,
      );
      resource.release = {
        action:
          safe && !current && !released && !transitional
            ? inspection.stale
              ? "release-occupancy"
              : "stop-and-release"
            : null,
        disabledReason: current
          ? "请从另一个控制连接停止当前 Backend 所属 Session"
          : transitional
            ? "资源正在启动或清理，请稍后手动刷新"
            : !safe || released
              ? "无法安全停止当前进程，请检查占用身份"
              : null,
      };
      resources.push(resource);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      const resource = emptyResource(
        `session:${entry.name}`,
        "desktop-session",
        entry.name,
      );
      resource.reason = "Session 资料损坏或无法读取，状态未知";
      resources.push(resource);
      reason = "部分 Session 资料无法读取";
    }
  }
  return { resources, reason };
}

export async function desktopSnapshot(generation, backendPid) {
  const sessions = await inspectSessions(generation, backendPid);
  try {
    const pool = await inspectBetaPool();
    const resources = [];
    for (const slot of pool.slots) {
      const resource = emptyResource(
        `slot:${slot.slotId}`,
        "desktop-slot",
        `Runweave Beta · ${slot.slotId.slice(-2)}`,
      );
      resource.state =
        slot.derivedState === "idle"
          ? slot.recovery.checks.slotProcessesAbsent
            ? "free"
            : "unknown"
          : ["healthy", "degraded-shared"].includes(slot.derivedState)
            ? "busy"
            : "blocked";
      resource.reason =
        resource.state === "unknown"
          ? "槽位仍有进程或进程资料未知"
          : slot.recovery.blockedBy.join("；") ||
            slot.reasons.join("；") ||
            null;
      if (
        resource.state === "blocked" &&
        slot.metadata.lastRecoveryAttempt?.ownerSessionId ===
          slot.lease.owner?.sessionId &&
        slot.metadata.lastRecoveryAttempt?.failureReason
      )
        resource.reason = slot.metadata.lastRecoveryAttempt.failureReason;
      resource.release.disabledReason =
        resource.state === "free" ? null : "无法确认完整占用身份";
      if (slot.lease.state === "valid") {
        resource.ownershipVersion = ownershipVersion(
          generation,
          slotIdentity(slot),
        );
        resource.owner = {
          id: slot.lease.owner.sessionId,
          task: null,
          worktree: path.basename(slot.lease.owner.sourceRoot),
          startedAt: slot.lease.acquiredAt,
          lastActivityAt: null,
        };
        resource.details.path = slot.lease.owner.sourceRoot;
        if (slot.manifest.readState === "valid") {
          let manifest;
          try {
            manifest = await readManifest(slot.lease.owner.sessionId);
          } catch {
            resource.state = "unknown";
            resource.reason = "占用者 manifest 无法读取";
            resources.push(resource);
            continue;
          }
          if (
            manifest.targetEnvironment?.betaSlot?.leaseNonce !==
            slot.lease.owner.leaseNonce
          ) {
            resource.state = "unknown";
            resource.reason = "读取期间占用者变化";
          } else {
            resource.details = manifestDetails(manifest);
            resource.owner = manifestOwner(manifest);
            const current = protectsBackend(manifest, backendPid);
            const transitional = ["planned", "starting", "stopping"].includes(
              manifest.state,
            );
            const safe =
              resource.details.processes.every(
                (item) => item.ownership !== "unknown",
              ) && slot.derivedState !== "stale-manual";
            const releasable =
              resource.state === "busy" ||
              (resource.state === "blocked" && slot.recovery.eligible);
            resource.release = {
              action:
                !current && !transitional && safe && releasable
                  ? resource.state === "busy"
                    ? "stop-and-release"
                    : "release-occupancy"
                  : null,
              disabledReason: current
                ? "请从另一个控制连接停止当前 Backend 所属 Session"
                : transitional
                  ? "资源正在启动或清理，请稍后手动刷新"
                  : safe && releasable
                    ? null
                    : "归属或清理条件尚未确认，请检查占用信息",
            };
          }
        }
      }
      resources.push(resource);
    }
    // Do not combine an observation with a different generation of the lease.
    const second = await inspectBetaPool();
    for (const resource of resources) {
      const slot = second.slots.find(
        (item) => `slot:${item.slotId}` === resource.id,
      );
      if (
        resource.ownershipVersion &&
        resource.ownershipVersion !==
          ownershipVersion(generation, slotIdentity(slot))
      ) {
        resource.state = "unknown";
        resource.reason = "读取期间占用者变化";
        resource.release = { action: null, disabledReason: resource.reason };
        resource.owner = null;
        resource.details = emptyResource("", "desktop-slot", "").details;
      }
    }
    return {
      ...group(resources, sessions.reason),
      sessions: sessions.resources,
    };
  } catch {
    return {
      ...unavailable("Beta Pool 无法读取，请检查 registry 和目录安全"),
      sessions: sessions.resources,
    };
  }
}

export async function simulatorSnapshot(generation) {
  if (process.platform !== "darwin")
    return unavailable("当前系统不支持 iOS 模拟器", "unsupported");
  try {
    const result = await exec("python3", ["-B", pythonEntry], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 40_000,
    });
    const value = JSON.parse(result.stdout);
    for (const resource of value.resources) {
      resource.ownershipVersion = resource.ownershipVersion
        ? ownershipVersion(generation, resource.ownershipVersion)
        : null;
    }
    return value;
  } catch {
    return unavailable("无法读取模拟器资源，请检查 Python、Xcode 与 pool 资料");
  }
}

export async function inspectResources({ generation, backendPid }) {
  const [desktop, simulators] = await Promise.all([
    desktopSnapshot(generation, backendPid),
    simulatorSnapshot(generation),
  ]);
  return {
    protocolVersion: 1,
    observedAt: new Date().toISOString(),
    hostId: ownershipVersion("host", [os.hostname(), os.homedir()]),
    hostName: os.hostname(),
    backendGeneration: generation,
    desktop,
    simulators,
  };
}
