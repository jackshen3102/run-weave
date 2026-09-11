import { execFileSync } from "node:child_process";
import { DevSessionError } from "../contracts.mjs";
import { isProcessLive, processIdentityMatches } from "./runtime.mjs";

const GRACE_MS = 5_000;
const FORCE_WAIT_MS = 2_000;
const POLL_MS = 100;

// spawnDetached creates a fresh session/process group whose ID is the launcher
// PID. Do not infer ownership from a port, command basename or an arbitrary tree.
export function readOwnedProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new DevSessionError("invalid owned process group", 5, { pid });
  }
  let output;
  try {
    output = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    throw new DevSessionError("cannot inspect owned process group", 5, { pid });
  }
  return output.split(/\r?\n/).flatMap((line) => {
    const [memberPid, groupPid, state] = line.trim().split(/\s+/);
    return Number(groupPid) === pid && state && !state.startsWith("Z")
      ? [Number(memberPid)]
      : [];
  });
}

function assertLauncherIdentity(processInfo) {
  if (!processIdentityMatches(processInfo)) {
    throw new DevSessionError(
      "owned process identity no longer matches; refusing to stop",
      5,
      { pid: processInfo.pid },
    );
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForGroupExit(processInfo, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const members = readOwnedProcessGroup(processInfo.pid);
    if (members.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export async function stopOwnedProcess(processInfo) {
  if (!processInfo?.pid) return { outcome: "already-stopped" };
  const members = readOwnedProcessGroup(processInfo.pid);
  if (!isProcessLive(processInfo.pid) && members.length === 0) {
    return { outcome: "already-stopped" };
  }
  assertLauncherIdentity(processInfo);
  if (!members.includes(processInfo.pid)) {
    throw new DevSessionError(
      "owned launcher is not its process group leader",
      5,
      {
        pid: processInfo.pid,
      },
    );
  }

  // Only the launcher receives SIGTERM. pnpm/tsx forward it themselves;
  // signalling their entire group would reach the child twice and make tsx
  // force-kill it while it is still draining resources.
  signal(processInfo.pid, "SIGTERM");
  if (await waitForGroupExit(processInfo, GRACE_MS)) {
    return { outcome: "exited" };
  }

  // The launcher must still prove ownership at escalation time. If it has gone
  // but left unknown members behind, fail closed rather than kill a reused PGID.
  assertLauncherIdentity(processInfo);
  signal(-processInfo.pid, "SIGKILL");
  if (!(await waitForGroupExit(processInfo, FORCE_WAIT_MS))) {
    throw new DevSessionError("owned process group remains after stop", 5, {
      pid: processInfo.pid,
      remainingPids: readOwnedProcessGroup(processInfo.pid),
    });
  }
  return { outcome: "forced" };
}

// Startup rollback uses the same captured launcher identity and signal rules.
export const stopSpawnedProcess = stopOwnedProcess;
