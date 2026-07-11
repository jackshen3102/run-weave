import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  formatBackendProfileLockConflict,
  getBrowserProfileLockFile,
  isProcessLive,
  killProcessIfLive,
  readBackendProfileLockOwner,
  readParentPid,
  readProcessCommand,
  resolveBrowserProfileDir,
  waitForProcessExit,
} from "@runweave/shared/browser-profile-node";
import type { RuntimeRelease } from "./runtime-release.js";
import type { PackagedBackendRuntimeIncidentEvent } from "./backend-runtime-types.js";

const ORPHANED_BACKEND_EXIT_TIMEOUT_MS = 2_000;
const PACKAGED_BACKEND_CLI_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

export function buildPackagedBackendPath(basePath: string | undefined): string {
  const entries = [
    ...(basePath?.split(path.delimiter) ?? []),
    ...PACKAGED_BACKEND_CLI_PATHS,
  ]
    .map((entry) => entry.trim())
    .filter(Boolean);

  return Array.from(new Set(entries)).join(path.delimiter);
}

export function getNodePtySpawnHelperPath(nodePtyDir: string): string {
  return path.join(
    nodePtyDir,
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
}

export function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function preparePackagedNodePtyDir(options: {
  nodePtyDir: string;
  onIncidentEvent?: (event: PackagedBackendRuntimeIncidentEvent) => void;
  release: RuntimeRelease;
  runtimeRoot: string | null;
}): string {
  if (process.platform !== "darwin") {
    return options.nodePtyDir;
  }

  const sourceHelper = getNodePtySpawnHelperPath(options.nodePtyDir);
  if (isExecutableFile(sourceHelper)) {
    return options.nodePtyDir;
  }

  if (!options.runtimeRoot) {
    return options.nodePtyDir;
  }

  const targetNodePtyDir = path.join(
    options.runtimeRoot,
    "node-pty",
    `${options.release.source}-${options.release.releaseId}-${process.arch}`,
  );
  const targetHelper = getNodePtySpawnHelperPath(targetNodePtyDir);

  try {
    rmSync(targetNodePtyDir, { recursive: true, force: true });
    mkdirSync(path.dirname(targetNodePtyDir), { recursive: true });
    cpSync(options.nodePtyDir, targetNodePtyDir, { recursive: true });
    chmodSync(targetHelper, 0o755);
    options.onIncidentEvent?.({
      event: "packagedBackend.nodePty.migrated",
      level: "warn",
      details: {
        releaseId: options.release.releaseId,
        source: options.nodePtyDir,
        target: targetNodePtyDir,
      },
    });
    return targetNodePtyDir;
  } catch (error) {
    options.onIncidentEvent?.({
      event: "packagedBackend.nodePty.migrationFailed",
      level: "error",
      details: {
        releaseId: options.release.releaseId,
        source: options.nodePtyDir,
        target: targetNodePtyDir,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (existsSync(sourceHelper)) {
      try {
        chmodSync(sourceHelper, 0o755);
      } catch {
        // Keep the original path so backend startup reports the real spawn error.
      }
    }
    return options.nodePtyDir;
  }
}

export async function recoverOrphanedPackagedBackendLock(
  env: NodeJS.ProcessEnv,
  onIncidentEvent?: (event: PackagedBackendRuntimeIncidentEvent) => void,
): Promise<void> {
  const profileDir = resolveBrowserProfileDir(env);
  const lockFile = getBrowserProfileLockFile(profileDir);
  const owner = await readBackendProfileLockOwner(lockFile);
  if (!owner || !isProcessLive(owner.pid)) {
    return;
  }

  const parentPid = await readParentPid(owner.pid);
  const command = await readProcessCommand(owner.pid);
  const isOrphanedPackagedBackend =
    parentPid === 1 &&
    owner.runtimeReleaseId !== null &&
    command?.includes("backend/index.cjs") === true;

  if (!isOrphanedPackagedBackend) {
    onIncidentEvent?.({
      event: "packagedBackend.profileLock.liveOwner",
      level: "warn",
      details: {
        profileDir,
        owner,
        parentPid,
        command,
      },
    });
    throw new Error(
      formatBackendProfileLockConflict(profileDir, lockFile, owner, {
        "parent pid": parentPid,
        command,
      }),
    );
  }

  console.warn("[electron] stopping orphaned packaged backend", {
    pid: owner.pid,
    port: owner.port,
    runtimeReleaseId: owner.runtimeReleaseId,
    profileDir,
  });
  onIncidentEvent?.({
    event: "packagedBackend.orphan.stop",
    level: "warn",
    details: {
      profileDir,
      owner,
      parentPid,
      command,
    },
  });

  killProcessIfLive(owner.pid, "SIGTERM");
  await waitForProcessExit(owner.pid, ORPHANED_BACKEND_EXIT_TIMEOUT_MS);
  if (isProcessLive(owner.pid)) {
    killProcessIfLive(owner.pid, "SIGKILL");
    await waitForProcessExit(owner.pid, ORPHANED_BACKEND_EXIT_TIMEOUT_MS);
  }
  onIncidentEvent?.({
    event: "packagedBackend.orphan.stopped",
    level: "warn",
    details: {
      profileDir,
      pid: owner.pid,
      stillLive: isProcessLive(owner.pid),
    },
  });
}
