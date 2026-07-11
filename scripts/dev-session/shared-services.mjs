import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DevSessionError } from "./contracts.mjs";
import {
  fetchHealthJson,
  inspectAppServerHandshake,
  inspectBackendHandshake,
  isProcessLive,
  readJson,
  readProcessSignature,
} from "./service-runtime.mjs";

export function throwRequiredSharedError(service, required, details) {
  if (!required) {
    return;
  }
  throw new DevSessionError(`required shared ${service} is incompatible`, 4, {
    service,
    ...details,
  });
}

export async function resolveSharedBackend(
  sourceRoot,
  revision,
  { required = false } = {},
) {
  const profileId = createHash("sha256")
    .update(sourceRoot)
    .digest("hex")
    .slice(0, 8);
  const profileDir = path.join(
    os.homedir(),
    ".runweave",
    "browser-profile",
    profileId,
  );
  const lockPath = path.join(profileDir, "backend.lock.json");
  const lock = await readJson(lockPath);
  if (
    !lock ||
    !Number.isInteger(lock.pid) ||
    !Number.isInteger(lock.port) ||
    typeof lock.backendId !== "string" ||
    typeof lock.startedAt !== "string" ||
    typeof lock.cwd !== "string"
  ) {
    throwRequiredSharedError("Backend", required, {
      reason: "default Backend lock is missing or invalid",
      expectedCapabilities: ["dev-session-identity-v1"],
      actualCapabilities: null,
      expected: { capabilities: ["dev-session-identity-v1"] },
      actual: null,
    });
    return null;
  }
  const url = `http://127.0.0.1:${lock.port}`;
  const processSignature = readProcessSignature(lock.pid);
  const service = {
    ownership: "shared-declared",
    serviceInstanceId: `backend:${lock.backendId}`,
    pid: lock.pid,
    url,
    resourceNamespace: `profile:${createHash("sha256").update(profileDir).digest("hex").slice(0, 12)}`,
    protocolVersion: 1,
    capabilities: ["dev-session-identity-v1"],
    sourceRevision: revision,
    sharedReason:
      "Resolved the source worktree default profile and verified lock/health/process identity",
    lockPath,
    lockStartedAt: lock.startedAt,
    lockCwd: lock.cwd,
    process: {
      pid: lock.pid,
      cwd: lock.cwd,
      startedAt: lock.startedAt,
      processSignature,
    },
  };
  const inspection = await inspectBackendHandshake(service);
  if (!inspection.ok) {
    const health = await fetchHealthJson(`${url}/health`);
    throwRequiredSharedError("Backend", required, {
      reason: inspection.reason,
      expectedCapabilities: service.capabilities,
      actualCapabilities: Array.isArray(health?.capabilities)
        ? health.capabilities
        : [],
      expected: {
        capabilities: service.capabilities,
        serviceInstanceId: service.serviceInstanceId,
        sourceRevision: service.sourceRevision,
      },
      actual: health,
    });
    return null;
  }
  return service;
}

export async function resolveSharedAppServer(revision, { required = false } = {}) {
  const homeDir = path.join(os.homedir(), ".runweave", "app-server");
  const lockPath = path.join(homeDir, "app-server.lock.json");
  const tokenPath = path.join(homeDir, "app-server-token");
  const lock = await readJson(lockPath);
  if (!lock || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port)) {
    throwRequiredSharedError("App Server", required, {
      reason: "default App Server lock is missing or invalid",
      expectedCapabilities: ["event-center-v1", "dev-session-identity-v1"],
      actualCapabilities: null,
    });
    return null;
  }
  const token = await readFile(tokenPath, "utf8").catch(() => "");
  if (!token.trim()) {
    throwRequiredSharedError("App Server", required, {
      reason: "default App Server token is missing",
      expectedCapabilities: ["event-center-v1", "dev-session-identity-v1"],
      actualCapabilities: null,
    });
    return null;
  }
  if (
    typeof lock.serviceInstanceId !== "string" ||
    typeof lock.startedAt !== "string" ||
    lock.sourceRevision !== revision ||
    typeof lock.entry !== "string"
  ) {
    throwRequiredSharedError("App Server", required, {
      reason: "default App Server lock identity is incompatible",
      expectedCapabilities: ["event-center-v1", "dev-session-identity-v1"],
      actualCapabilities: Array.isArray(lock.capabilities)
        ? lock.capabilities
        : [],
      actual: lock,
    });
    return null;
  }
  const service = {
    ownership: "shared-declared",
    serviceInstanceId: lock.serviceInstanceId,
    pid: lock.pid,
    url: `http://127.0.0.1:${lock.port}`,
    protocolVersion: 1,
    capabilities: ["event-center-v1", "dev-session-identity-v1"],
    sourceRevision: revision,
    sharedReason:
      "Resolved the default App Server and verified lock/health/process identity",
    lockPath,
    lockStartedAt: lock.startedAt,
    lockIdentity: {
      entry: lock.entry,
      releaseId: lock.releaseId ?? null,
      runtimeRoot: lock.runtimeRoot ?? null,
    },
    tokenPath,
    process: {
      pid: lock.pid,
      cwd: path.dirname(lock.entry),
      startedAt: lock.startedAt,
      processSignature: readProcessSignature(lock.pid),
    },
  };
  const inspection = await inspectAppServerHandshake(service);
  if (!inspection.ok) {
    const health = await fetchHealthJson(`${service.url}/healthz`);
    throwRequiredSharedError("App Server", required, {
      reason: inspection.reason,
      expectedCapabilities: service.capabilities,
      actualCapabilities: Array.isArray(health?.capabilities)
        ? health.capabilities
        : [],
      expected: {
        capabilities: service.capabilities,
        serviceInstanceId: service.serviceInstanceId,
        sourceRevision: service.sourceRevision,
      },
      actual: health,
    });
    return null;
  }
  return service;
}

export async function stopOwnedProcess(processInfo) {
  if (!processInfo?.pid || !isProcessLive(processInfo.pid)) {
    return;
  }
  const currentSignature = readProcessSignature(processInfo.pid);
  if (
    !processInfo.processSignature ||
    currentSignature !== processInfo.processSignature
  ) {
    throw new DevSessionError(
      "owned process identity no longer matches; refusing to stop",
      5,
      {
        pid: processInfo.pid,
        expectedSignature: processInfo.processSignature,
        actualSignature: currentSignature,
      },
    );
  }
  try {
    process.kill(-processInfo.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessLive(processInfo.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessLive(processInfo.pid)) {
    process.kill(-processInfo.pid, "SIGKILL");
  }
}

export async function stopSpawnedProcess(processInfo) {
  if (!processInfo?.pid || !isProcessLive(processInfo.pid)) {
    return;
  }
  try {
    process.kill(-processInfo.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessLive(processInfo.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessLive(processInfo.pid)) {
    process.kill(-processInfo.pid, "SIGKILL");
  }
}
