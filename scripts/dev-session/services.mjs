import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  bundleElectron,
  createBackendEnv,
  createFrontendEnv,
  resolveElectronBin,
  resolvePort,
} from "../../dev.mjs";
import { DevSessionError, assertLoopbackUrl } from "./contracts.mjs";
import {
  acquireServicePortLease,
  listManifestsForSource,
} from "./registry.mjs";
import {
  buildBetaStatus,
  resolveBetaPaths,
} from "../runweave-beta-state.mjs";

const execFileAsync = promisify(execFile);
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 200;

function isProcessLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessSignature(pid) {
  try {
    return execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      {
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return "";
  }
}

function spawnDetached({ name, command, args, cwd, env, logPath }) {
  const output = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", output, output],
      windowsHide: true,
    });
    child.unref();
  } finally {
    closeSync(output);
  }
  if (!child?.pid) {
    throw new DevSessionError(`failed to start ${name}`, 1);
  }
  return {
    pid: child.pid,
    command: [command, ...args].join(" "),
    cwd,
    startedAt: new Date().toISOString(),
    processSignature: readProcessSignature(child.pid),
    logPath,
  };
}

async function waitForJson(url, predicate, processInfo, options = {}) {
  const safeUrl = assertLoopbackUrl(url);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processInfo && !isProcessLive(processInfo.pid)) {
      throw new DevSessionError(
        `process exited before ready: ${processInfo.command}`,
        1,
        {
          logPath: processInfo.logPath,
        },
      );
    }
    const detectedFailure = await options.detectFailure?.();
    if (detectedFailure) {
      throw detectedFailure;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(safeUrl, { signal: controller.signal });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (predicate(body)) {
          return body;
        }
      }
    } catch {
      // Retry until the bounded readiness deadline.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
  throw new DevSessionError(`service did not become ready: ${safeUrl}`, 1, {
    logPath: processInfo?.logPath,
  });
}

async function waitForPage(url, processInfo) {
  const safeUrl = assertLoopbackUrl(url);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessLive(processInfo.pid)) {
      throw new DevSessionError(`frontend exited before ready: ${safeUrl}`, 1, {
        logPath: processInfo.logPath,
      });
    }
    try {
      const response = await fetch(safeUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the bounded readiness deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
  throw new DevSessionError(`frontend did not become ready: ${safeUrl}`, 1, {
    logPath: processInfo.logPath,
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchHealthJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(assertLoopbackUrl(url), {
      signal: controller.signal,
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveListeningPids(endpoint) {
  const port = Number(new URL(assertLoopbackUrl(endpoint)).port);
  if (!Number.isInteger(port) || port < 1) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    );
    return stdout
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

async function endpointHasPage(endpoint, expectedUrl) {
  const targets = await fetchHealthJson(`${endpoint}/json/list`);
  return (
    Array.isArray(targets) &&
    targets.some(
      (target) =>
        target?.type === "page" &&
        typeof target.url === "string" &&
        target.url.startsWith(expectedUrl),
    )
  );
}

function hasCapabilities(actual, expected) {
  return (
    Array.isArray(actual) &&
    expected.every((capability) => actual.includes(capability))
  );
}

function processIdentityMatches(processInfo) {
  return Boolean(
    processInfo?.pid &&
    isProcessLive(processInfo.pid) &&
    processInfo.processSignature &&
    readProcessSignature(processInfo.pid) === processInfo.processSignature,
  );
}

async function inspectBackendHandshake(service) {
  if (!processIdentityMatches(service.process)) {
    return { ok: false, reason: "backend process identity drifted" };
  }
  const lock = await readJson(service.lockPath);
  const url = new URL(service.url);
  if (
    !lock ||
    lock.pid !== service.pid ||
    `backend:${lock.backendId}` !== service.serviceInstanceId ||
    lock.port !== Number(url.port) ||
    lock.startedAt !== service.lockStartedAt ||
    lock.cwd !== service.lockCwd
  ) {
    return { ok: false, reason: "backend lock identity drifted" };
  }
  const health = await fetchHealthJson(`${service.url}/health`);
  const expectedDevSessionId = service.ownerDevSessionId ?? null;
  if (
    health?.status !== "ok" ||
    health.service !== "runweave-backend" ||
    health.serviceInstanceId !== service.serviceInstanceId ||
    (health.devSessionId ?? null) !== expectedDevSessionId ||
    health.sourceRevision !== service.sourceRevision ||
    health.resourceNamespace !== service.resourceNamespace ||
    health.protocolVersion !== service.protocolVersion ||
    !hasCapabilities(health.capabilities, service.capabilities)
  ) {
    return { ok: false, reason: "backend health identity drifted" };
  }
  return { ok: true, reason: null };
}

async function inspectAppServerHandshake(service) {
  if (!processIdentityMatches(service.process)) {
    return { ok: false, reason: "app server process identity drifted" };
  }
  const lock = await readJson(service.lockPath);
  const url = new URL(service.url);
  if (
    !lock ||
    lock.pid !== service.pid ||
    lock.serviceInstanceId !== service.serviceInstanceId ||
    lock.port !== Number(url.port) ||
    lock.startedAt !== service.lockStartedAt ||
    lock.sourceRevision !== service.sourceRevision ||
    lock.entry !== service.lockIdentity.entry ||
    lock.releaseId !== service.lockIdentity.releaseId ||
    lock.runtimeRoot !== service.lockIdentity.runtimeRoot
  ) {
    return { ok: false, reason: "app server lock identity drifted" };
  }
  const health = await fetchHealthJson(`${service.url}/healthz`);
  const expectedDevSessionId = service.ownerDevSessionId ?? null;
  if (
    health?.ok !== true ||
    health.service !== "runweave-app-server" ||
    health.pid !== service.pid ||
    health.serviceInstanceId !== service.serviceInstanceId ||
    (health.devSessionId ?? null) !== expectedDevSessionId ||
    health.sourceRevision !== service.sourceRevision ||
    health.protocolVersion !== service.protocolVersion ||
    !hasCapabilities(health.capabilities, service.capabilities)
  ) {
    return { ok: false, reason: "app server health identity drifted" };
  }
  return { ok: true, reason: null };
}

async function inspectElectronHandshake(service) {
  if (!processIdentityMatches(service.process)) {
    return { ok: false, reason: "Electron process identity drifted" };
  }
  const status = await readJson(service.statusPath);
  if (
    !status ||
    status.channel !== service.channel ||
    status.instanceId !== service.instanceId ||
    status.devSessionId !== service.ownerDevSessionId ||
    status.sourceRevision !== service.sourceRevision ||
    status.app?.pid !== service.pid ||
    status.cdp?.desktop?.endpoint !== service.desktopCdpEndpoint ||
    status.cdp?.terminalBrowser?.endpoint !== service.terminalBrowserCdpEndpoint
  ) {
    return { ok: false, reason: "Electron status identity drifted" };
  }
  const [desktopVersion, terminalBrowserVersion] = await Promise.all([
    fetchHealthJson(`${service.desktopCdpEndpoint}/json/version`),
    fetchHealthJson(`${service.terminalBrowserCdpEndpoint}/json/version`),
  ]);
  const [desktopListeningPids, terminalListeningPids, desktopHasPage] =
    await Promise.all([
      resolveListeningPids(service.desktopCdpEndpoint),
      resolveListeningPids(service.terminalBrowserCdpEndpoint),
      endpointHasPage(service.desktopCdpEndpoint, service.frontendUrl),
    ]);
  if (
    !desktopVersion ||
    !terminalBrowserVersion ||
    !desktopListeningPids.includes(service.pid) ||
    !terminalListeningPids.includes(service.pid) ||
    !desktopHasPage ||
    terminalBrowserVersion["Runweave-Surface"] !== "terminal-browser" ||
    terminalBrowserVersion["Runweave-Instance-Id"] !== service.instanceId ||
    terminalBrowserVersion["Runweave-Dev-Session-Id"] !==
      service.ownerDevSessionId ||
    terminalBrowserVersion["Runweave-Source-Revision"] !==
      service.sourceRevision ||
    terminalBrowserVersion["Runweave-Pid"] !== service.pid
  ) {
    return { ok: false, reason: "Electron CDP endpoint drifted" };
  }
  return { ok: true, reason: null };
}

function resolveBetaReconciliationPaths(services) {
  const beta = services.beta;
  const desktopEndpoint = services.cdp?.desktop?.endpoint;
  const terminalBrowserEndpoint = services.cdp?.terminalBrowser?.endpoint;
  if (
    beta?.ownership !== "dedicated" ||
    beta.channel !== "beta" ||
    !beta.instanceId ||
    !beta.ownerDevSessionId ||
    !beta.userDataDir ||
    !beta.betaControl?.cwd ||
    !desktopEndpoint ||
    !terminalBrowserEndpoint
  ) {
    return null;
  }
  let desktopCdpPort;
  let terminalBrowserCdpPort;
  try {
    desktopCdpPort = Number(
      new URL(assertLoopbackUrl(desktopEndpoint)).port,
    );
    terminalBrowserCdpPort = Number(
      new URL(assertLoopbackUrl(terminalBrowserEndpoint)).port,
    );
  } catch {
    return null;
  }
  const homeDir = path.resolve(beta.userDataDir, "../../../../../..");
  const paths = resolveBetaPaths(
    beta.betaControl.cwd,
    homeDir,
    beta.instanceId,
    beta.ownerDevSessionId,
    { desktopCdpPort, terminalBrowserCdpPort },
  );
  if (
    paths.userData !== beta.userDataDir ||
    paths.desktopStatusPath !== beta.statusPath ||
    paths.appPath !== beta.appPath ||
    `http://127.0.0.1:${paths.desktopCdpPort}` !== desktopEndpoint ||
    `http://127.0.0.1:${paths.terminalBrowserCdpPort}` !==
      terminalBrowserEndpoint
  ) {
    return null;
  }
  return paths;
}

async function reconcileBetaSessionServices(services) {
  const paths = resolveBetaReconciliationPaths(services);
  if (!paths) {
    return null;
  }
  const beta = services.beta;
  const [status, desktopState] = await Promise.all([
    buildBetaStatus(paths),
    readJson(paths.desktopStatusPath),
  ]);
  const revision = status.source.gitHead;
  if (
    status.channel !== "beta" ||
    status.instanceId !== beta.instanceId ||
    status.devSessionId !== beta.ownerDevSessionId ||
    typeof revision !== "string" ||
    !revision ||
    desktopState?.sourceRevision !== revision ||
    status.desktop.appPath !== beta.appPath ||
    status.desktop.userDataPath !== beta.userDataDir ||
    status.desktop.statusPath !== beta.statusPath ||
    status.cdp.desktop.endpoint !== services.cdp.desktop.endpoint ||
    status.cdp.terminalBrowser.endpoint !==
      services.cdp.terminalBrowser.endpoint ||
    !status.desktop.healthy ||
    !status.backend.healthy ||
    !status.appServer.healthy ||
    !status.cdp.desktop.healthy ||
    !status.cdp.terminalBrowser.healthy
  ) {
    return null;
  }
  const backend = services.backend;
  const appServer = services.appServer;
  if (
    status.backend.profileDir !== backend.profileDir ||
    status.backend.profileLockPath !== backend.lockPath ||
    status.appServer.lockPath !== appServer.lockPath ||
    status.appServer.home !== appServer.homeDir
  ) {
    return null;
  }
  const [backendLock, backendHealth, appServerLock, appServerHealth] =
    await Promise.all([
      readJson(backend.lockPath),
      fetchHealthJson(`${status.backend.baseUrl}/health`),
      readJson(appServer.lockPath),
      fetchHealthJson(`${status.appServer.baseUrl}/healthz`),
    ]);
  if (
    !backendLock ||
    backendHealth?.status !== "ok" ||
    backendHealth.service !== "runweave-backend" ||
    typeof backendHealth.serviceInstanceId !== "string" ||
    typeof backendHealth.protocolVersion !== "number" ||
    !Array.isArray(backendHealth.capabilities) ||
    !appServerLock ||
    appServerHealth?.ok !== true ||
    appServerHealth.service !== "runweave-app-server" ||
    typeof appServerHealth.serviceInstanceId !== "string" ||
    typeof appServerHealth.protocolVersion !== "number" ||
    !Array.isArray(appServerHealth.capabilities)
  ) {
    return null;
  }
  if (
    backend.ownership === "dedicated" &&
    (backendLock.pid !== status.backend.pid ||
      typeof backendLock.startedAt !== "string" ||
      typeof backendLock.cwd !== "string" ||
      `backend:${backendLock.backendId}` !== backendHealth.serviceInstanceId ||
      (backendHealth.devSessionId ?? null) !== beta.ownerDevSessionId ||
      backendHealth.sourceRevision !== revision)
  ) {
    return null;
  }
  if (
    appServer.ownership === "dedicated" &&
    (appServerLock.pid !== status.appServer.pid ||
      typeof appServerLock.startedAt !== "string" ||
      typeof appServerLock.entry !== "string" ||
      appServerHealth.pid !== appServerLock.pid ||
      appServerLock.serviceInstanceId !== appServerHealth.serviceInstanceId ||
      (appServerHealth.devSessionId ?? null) !== beta.ownerDevSessionId ||
      appServerHealth.sourceRevision !== revision)
  ) {
    return null;
  }
  const desktopProcess = {
    ...beta.process,
    pid: status.desktop.pid,
    command: desktopState.app.executable,
    startedAt: desktopState.app.startedAt,
    processSignature: desktopState.app.processSignature,
    logPath: status.update.logPath ?? beta.process.logPath,
  };
  const reconciled = structuredClone(services);
  reconciled.frontend = {
    ...reconciled.frontend,
    serviceInstanceId: `beta-renderer:${beta.instanceId}:${status.desktop.pid}`,
    pid: status.desktop.pid,
    sourceRevision: revision,
    expectedBackendServiceInstanceId: backendHealth.serviceInstanceId,
    process: desktopProcess,
  };
  for (const serviceName of ["electron", "beta"]) {
    reconciled[serviceName] = {
      ...reconciled[serviceName],
      serviceInstanceId:
        serviceName === "electron"
          ? `beta:${beta.instanceId}:${status.desktop.pid}`
          : `beta-control:${beta.instanceId}`,
      pid: status.desktop.pid,
      sourceRevision: revision,
      process: desktopProcess,
    };
  }
  if (backend.ownership === "dedicated") {
    reconciled.backend = {
      ...reconciled.backend,
      serviceInstanceId: backendHealth.serviceInstanceId,
      pid: backendLock.pid,
      url: status.backend.baseUrl,
      resourceNamespace:
        backendHealth.resourceNamespace ?? reconciled.backend.resourceNamespace,
      protocolVersion: backendHealth.protocolVersion,
      capabilities: backendHealth.capabilities,
      sourceRevision: revision,
      lockStartedAt: backendLock.startedAt,
      lockCwd: backendLock.cwd,
      process: {
        ...reconciled.backend.process,
        pid: backendLock.pid,
        cwd: backendLock.cwd,
        startedAt: backendLock.startedAt,
        processSignature: readProcessSignature(backendLock.pid),
        logPath: status.update.logPath ?? reconciled.backend.process.logPath,
      },
    };
  }
  if (appServer.ownership === "dedicated") {
    reconciled.appServer = {
      ...reconciled.appServer,
      serviceInstanceId: appServerHealth.serviceInstanceId,
      pid: appServerLock.pid,
      url: status.appServer.baseUrl,
      protocolVersion: appServerHealth.protocolVersion,
      capabilities: appServerHealth.capabilities,
      sourceRevision: revision,
      lockStartedAt: appServerLock.startedAt,
      lockIdentity: {
        entry: appServerLock.entry,
        releaseId: appServerLock.releaseId ?? null,
        runtimeRoot: appServerLock.runtimeRoot ?? null,
      },
      process: {
        ...reconciled.appServer.process,
        pid: appServerLock.pid,
        cwd: appServerLock.runtimeRoot ?? appServer.homeDir,
        startedAt: appServerLock.startedAt,
        processSignature: readProcessSignature(appServerLock.pid),
        logPath: status.appServer.logPath,
      },
    };
  }
  reconciled.cdp.desktop = {
    ...reconciled.cdp.desktop,
    pid: status.desktop.pid,
    sourceRevision: revision,
  };
  reconciled.cdp.terminalBrowser = {
    ...reconciled.cdp.terminalBrowser,
    pid: status.desktop.pid,
    sourceRevision: revision,
  };
  return {
    services: reconciled,
    sourceRevision: revision,
    sourceDirty: status.source.dirty,
  };
}

async function waitForDesktopStatus(statusPath, predicate, processInfo) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessLive(processInfo.pid)) {
      throw new DevSessionError("Electron exited before writing status", 1, {
        logPath: processInfo.logPath,
      });
    }
    const status = await readJson(statusPath);
    if (status && predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
  throw new DevSessionError("Electron did not write a ready status", 1, {
    statusPath,
    logPath: processInfo.logPath,
  });
}

function throwRequiredSharedError(service, required, details) {
  if (!required) {
    return;
  }
  throw new DevSessionError(`required shared ${service} is incompatible`, 4, {
    service,
    ...details,
  });
}

async function resolveSharedBackend(
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

async function resolveSharedAppServer(revision, { required = false } = {}) {
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

async function stopOwnedProcess(processInfo) {
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

async function stopSpawnedProcess(processInfo) {
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

async function startDedicatedAppServer({
  sourceRoot,
  sessionId,
  revision,
  paths,
  port,
  onSpawn,
}) {
  const homeDir = path.join(paths.sessionDir, "app-server");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const serviceInstanceId = `app-server:${randomUUID()}`;
  const processInfo = spawnDetached({
    name: "app-server",
    command: "pnpm",
    args: ["--filter", "@runweave/app-server", "dev"],
    cwd: sourceRoot,
    env: {
      ...process.env,
      RUNWEAVE_APP_SERVER_HOME: homeDir,
      RUNWEAVE_APP_SERVER_STATE_DIR: homeDir,
      RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR: path.join(homeDir, "cloud-sync"),
      RUNWEAVE_APP_SERVER_PORT: String(port),
      RUNWEAVE_APP_SERVER_SOURCE: "local",
      RUNWEAVE_DEV_SESSION_ID: sessionId,
      RUNWEAVE_SERVICE_INSTANCE_ID: serviceInstanceId,
      RUNWEAVE_SOURCE_REVISION: revision,
    },
    logPath: path.join(paths.logsDir, "app-server.log"),
  });
  onSpawn(processInfo);
  const lockPath = path.join(homeDir, "app-server.lock.json");
  const health = await waitForJson(
    `http://127.0.0.1:${port}/healthz`,
    (body) =>
      body?.ok === true &&
      body?.serviceInstanceId === serviceInstanceId &&
      body?.devSessionId === sessionId &&
      body?.sourceRevision === revision &&
      hasCapabilities(body?.capabilities, ["dev-session-identity-v1"]),
    processInfo,
  );
  processInfo.processSignature = readProcessSignature(processInfo.pid);
  const lock = await readJson(lockPath);
  if (!lock || lock.serviceInstanceId !== serviceInstanceId) {
    throw new DevSessionError(
      "dedicated App Server lock identity is missing",
      4,
    );
  }
  return {
    ownership: "dedicated",
    serviceInstanceId,
    ownerDevSessionId: sessionId,
    pid: health.pid,
    url: `http://127.0.0.1:${port}`,
    protocolVersion: health.protocolVersion,
    capabilities: health.capabilities,
    sourceRevision: revision,
    homeDir,
    lockPath,
    lockStartedAt: lock.startedAt,
    lockIdentity: {
      entry: lock.entry,
      releaseId: lock.releaseId ?? null,
      runtimeRoot: lock.runtimeRoot ?? null,
    },
    tokenPath: path.join(homeDir, "app-server-token"),
    process: processInfo,
  };
}

async function startDedicatedBackend({
  sourceRoot,
  sessionId,
  revision,
  paths,
  port,
  appServer,
  onSpawn,
}) {
  const profileDir = path.join(paths.sessionDir, "browser-profile");
  const lockPath = path.join(profileDir, "backend.lock.json");
  const logPath = path.join(paths.logsDir, "backend.log");
  const namespace = `profile:${createHash("sha256").update(profileDir).digest("hex").slice(0, 12)}`;
  const detectProfileConflict = () =>
    detectDedicatedBackendProfileConflict({
      sourceRoot,
      requestedSessionId: sessionId,
      requestedPort: port,
      profileDir,
      lockPath,
      logPath,
      sessionRoot: paths.root,
    });
  const preflightConflict = await detectProfileConflict();
  if (preflightConflict) {
    throw preflightConflict;
  }
  let appServerToken;
  if (appServer?.url) {
    appServerToken = readFileSync(appServer.tokenPath, "utf8").trim();
  }
  const backendBaseEnv = { ...process.env };
  for (const key of [
    "RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR",
    "RUNWEAVE_APP_SERVER_DISCOVERY",
    "RUNWEAVE_APP_SERVER_HOME",
    "RUNWEAVE_APP_SERVER_STATE_DIR",
    "RUNWEAVE_APP_SERVER_TOKEN",
    "RUNWEAVE_APP_SERVER_URL",
  ]) {
    delete backendBaseEnv[key];
  }
  const processInfo = spawnDetached({
    name: "backend",
    command: "pnpm",
    args: [
      "-C",
      "./backend",
      "dev",
      "--",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    cwd: sourceRoot,
    env: {
      ...createBackendEnv({ baseEnv: backendBaseEnv, backendPort: port }),
      RUNWEAVE_DEV_BROWSER_PROFILE_DIR: profileDir,
      BROWSER_PROFILE_DIR: profileDir,
      RUNWEAVE_DEV_SESSION_ID: sessionId,
      RUNWEAVE_SOURCE_REVISION: revision,
      RUNWEAVE_RESOURCE_NAMESPACE: namespace,
      RUNWEAVE_APP_SERVER_DISCOVERY: appServer?.url ? "explicit" : "disabled",
      ...(appServer?.url
        ? {
            RUNWEAVE_APP_SERVER_URL: appServer.url,
            RUNWEAVE_APP_SERVER_TOKEN: appServerToken,
          }
        : {}),
    },
    logPath,
  });
  onSpawn(processInfo);
  const health = await waitForJson(
    `http://127.0.0.1:${port}/health`,
    (body) =>
      body?.status === "ok" &&
      body?.service === "runweave-backend" &&
      body?.devSessionId === sessionId &&
      body?.sourceRevision === revision &&
      body?.resourceNamespace === namespace &&
      hasCapabilities(body?.capabilities, ["dev-session-identity-v1"]),
    processInfo,
    { detectFailure: detectProfileConflict },
  );
  processInfo.processSignature = readProcessSignature(processInfo.pid);
  const lock = await readJson(lockPath);
  if (!lock || `backend:${lock.backendId}` !== health.serviceInstanceId) {
    throw new DevSessionError("dedicated Backend lock identity is missing", 4);
  }
  return {
    ownership: "dedicated",
    serviceInstanceId: health.serviceInstanceId,
    ownerDevSessionId: sessionId,
    pid: lock.pid,
    url: `http://127.0.0.1:${port}`,
    resourceNamespace: namespace,
    protocolVersion: health.protocolVersion,
    capabilities: health.capabilities,
    sourceRevision: revision,
    profileDir,
    lockPath,
    lockStartedAt: lock.startedAt,
    lockCwd: lock.cwd,
    process: processInfo,
  };
}

async function detectDedicatedBackendProfileConflict({
  sourceRoot,
  requestedSessionId,
  requestedPort,
  profileDir,
  lockPath,
  logPath,
  sessionRoot,
}) {
  const owner = await readJson(lockPath);
  if (
    !owner ||
    typeof owner.backendId !== "string" ||
    !Number.isInteger(owner.pid) ||
    !isProcessLive(owner.pid)
  ) {
    return null;
  }
  if (owner.devSessionId === requestedSessionId) {
    return null;
  }

  const manifests = await listManifestsForSource(sourceRoot, {
    ...process.env,
    RUNWEAVE_DEV_SESSION_HOME: sessionRoot,
  });
  const serviceInstanceId = `backend:${owner.backendId}`;
  const ownerManifest = manifests.find((manifest) => {
    const backend = manifest.services?.backend;
    return (
      backend?.serviceInstanceId === serviceInstanceId &&
      backend?.pid === owner.pid
    );
  });
  const ownerDevSessionId =
    (typeof owner.devSessionId === "string" && owner.devSessionId.trim()) ||
    ownerManifest?.devSessionId ||
    null;
  if (ownerDevSessionId === requestedSessionId) {
    return null;
  }
  const ownerBackend = ownerManifest?.services?.backend;
  const stopCommand = ownerDevSessionId
    ? `pnpm dev:stop --session ${ownerDevSessionId}`
    : null;
  const guidance = ownerDevSessionId
    ? `Verify the owning Session is no longer needed, then run ${stopCommand}; do not delete a live backend profile lock. Retry ${requestedSessionId} after the owner stops.`
    : "Verify the owner PID and port, stop that Backend cleanly if it is no longer needed, and retry; do not delete a live backend profile lock.";
  return new DevSessionError(
    `Backend profile conflict for ${requestedSessionId}: owner Session ${ownerDevSessionId ?? "unknown"}, pid=${owner.pid}, port=${owner.port ?? "unknown"}`,
    5,
    {
      conflict: {
        type: "backend-profile-lock",
        resource: {
          profileDir,
          lockPath,
          requestedPort,
        },
        requested: {
          devSessionId: requestedSessionId,
          sourceRoot,
        },
        owner: {
          devSessionId: ownerDevSessionId,
          sessionState: ownerManifest?.state ?? null,
          serviceInstanceId,
          pid: owner.pid,
          port: owner.port ?? null,
          host: owner.host ?? null,
          cwd: owner.cwd ?? null,
          startedAt: owner.startedAt ?? null,
          runtimeReleaseId: owner.runtimeReleaseId ?? null,
          resourceNamespace: ownerBackend?.resourceNamespace ?? null,
          sourceRevision: ownerBackend?.sourceRevision ?? null,
        },
        remediation: {
          action: ownerDevSessionId
            ? "stop-owning-dev-session"
            : "inspect-owning-backend",
          command: stopCommand,
          guidance,
        },
      },
      logPath,
    },
  );
}

async function startDedicatedFrontend({
  sourceRoot,
  sessionId,
  revision,
  paths,
  port,
  backend,
  onSpawn,
}) {
  const serviceInstanceId = `frontend:${randomUUID()}`;
  const backendPort = Number(new URL(backend.url).port);
  const processInfo = spawnDetached({
    name: "frontend",
    command: "pnpm",
    args: [
      "-C",
      "./frontend",
      "dev",
      "--",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    cwd: sourceRoot,
    env: {
      ...createFrontendEnv({
        baseEnv: process.env,
        backendPort,
        frontendHost: "127.0.0.1",
        frontendPort: String(port),
      }),
      VITE_RUNWEAVE_DEV_SESSION_ID: sessionId,
      VITE_RUNWEAVE_EXPECTED_BACKEND_ID: backend.serviceInstanceId,
      VITE_RUNWEAVE_EXPECTED_BACKEND_PROTOCOL: String(
        backend.protocolVersion ?? 0,
      ),
      VITE_RUNWEAVE_SOURCE_REVISION: revision,
    },
    logPath: path.join(paths.logsDir, "frontend.log"),
  });
  onSpawn(processInfo);
  const url = `http://127.0.0.1:${port}`;
  await waitForPage(url, processInfo);
  processInfo.processSignature = readProcessSignature(processInfo.pid);
  return {
    ownership: "dedicated",
    serviceInstanceId,
    ownerDevSessionId: sessionId,
    pid: processInfo.pid,
    url,
    sourceRevision: revision,
    expectedBackendServiceInstanceId: backend.serviceInstanceId,
    process: processInfo,
  };
}

async function startDedicatedElectron({
  sourceRoot,
  sessionId,
  instanceId,
  revision,
  paths,
  frontend,
  backend,
  appServer,
  desktopCdpPort,
  terminalBrowserCdpPort,
  channel,
  onSpawn,
}) {
  const electronDir = path.join(sourceRoot, "electron");
  const electronStateDir = path.join(paths.sessionDir, "electron");
  const userDataDir = path.join(electronStateDir, "user-data");
  const statusPath = path.join(electronStateDir, "desktop-status.json");
  const desktopProfileDir = path.join(userDataDir, "browser-profile");
  const cliConfigPath = path.join(userDataDir, "cli", "config.json");
  const bundleDir = path.join(electronStateDir, "bundle");
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  bundleElectron(electronDir, {
    ...process.env,
    RUNWEAVE_DESKTOP_CHANNEL: channel,
    RUNWEAVE_DESKTOP_SOURCE_REVISION: revision,
    RUNWEAVE_ELECTRON_BUNDLE_OUTDIR: bundleDir,
  });
  const electronBin = resolveElectronBin(electronDir);
  const desktopCdpEndpoint = `http://127.0.0.1:${desktopCdpPort}`;
  const terminalBrowserCdpEndpoint = `http://127.0.0.1:${terminalBrowserCdpPort}`;
  const electronEnv = {
    ...process.env,
    RUNWEAVE_DEV_URL: frontend.url,
    RUNWEAVE_BACKEND_URL: backend.url,
    RUNWEAVE_MANAGES_PACKAGED_BACKEND: "false",
    RUNWEAVE_DEV_SESSION_ID: sessionId,
    RUNWEAVE_DESKTOP_INSTANCE_ID: instanceId,
    RUNWEAVE_DESKTOP_USER_DATA_DIR: userDataDir,
    RUNWEAVE_DESKTOP_STATUS_PATH: statusPath,
    RUNWEAVE_DESKTOP_CDP_PORT: String(desktopCdpPort),
    RUNWEAVE_TERMINAL_BROWSER_CDP_PROXY_PORT: String(terminalBrowserCdpPort),
    RUNWEAVE_DESKTOP_CHANNEL: channel,
    RUNWEAVE_DESKTOP_SOURCE_REVISION: revision,
    RUNWEAVE_ELECTRON_DOCK_ICON_PATH: path.join(
      electronDir,
      "resources/icons/icon-preview.png",
    ),
    RUNWEAVE_ELECTRON_PRELOAD_PATH: path.join(bundleDir, "preload.cjs"),
    RUNWEAVE_ELECTRON_RESOURCES_DIR: path.join(electronDir, "resources"),
    RUNWEAVE_RENDERER_DIST_DIR: path.join(sourceRoot, "frontend/dist"),
    BROWSER_PROFILE_DIR: desktopProfileDir,
    AUTH_STORE_FILE: path.join(desktopProfileDir, "auth-store.json"),
    RUNWEAVE_CONFIG_FILE: cliConfigPath,
    ...(appServer?.homeDir
      ? { RUNWEAVE_APP_SERVER_HOME: appServer.homeDir }
      : appServer?.lockPath
        ? { RUNWEAVE_APP_SERVER_HOME: path.dirname(appServer.lockPath) }
        : {}),
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const processInfo = spawnDetached({
    name: channel === "beta" ? "beta" : "electron",
    command: electronBin,
    args: [path.join(bundleDir, "main.cjs")],
    cwd: sourceRoot,
    env: electronEnv,
    logPath: path.join(paths.logsDir, `${channel}-electron.log`),
  });
  onSpawn(processInfo);
  const status = await waitForDesktopStatus(
    statusPath,
    (value) =>
      value.channel === channel &&
      value.instanceId === instanceId &&
      value.devSessionId === sessionId &&
      value.sourceRevision === revision &&
      value.cdp?.desktop?.endpoint === desktopCdpEndpoint &&
      value.cdp?.terminalBrowser?.endpoint === terminalBrowserCdpEndpoint,
    processInfo,
  );
  const [desktopVersion, terminalBrowserVersion] = await Promise.all([
    waitForJson(desktopCdpEndpoint + "/json/version", Boolean, processInfo),
    waitForJson(
      terminalBrowserCdpEndpoint + "/json/version",
      (value) =>
        value?.["Runweave-Surface"] === "terminal-browser" &&
        value?.["Runweave-Instance-Id"] === instanceId &&
        value?.["Runweave-Dev-Session-Id"] === sessionId &&
        value?.["Runweave-Source-Revision"] === revision &&
        value?.["Runweave-Pid"] === status.app.pid,
      processInfo,
    ),
  ]);
  await waitForJson(
    desktopCdpEndpoint + "/json/list",
    (targets) =>
      Array.isArray(targets) &&
      targets.some(
        (target) =>
          target?.type === "page" &&
          typeof target.url === "string" &&
          target.url.startsWith(frontend.url),
      ),
    processInfo,
  );
  const [desktopListeningPids, terminalListeningPids] = await Promise.all([
    resolveListeningPids(desktopCdpEndpoint),
    resolveListeningPids(terminalBrowserCdpEndpoint),
  ]);
  if (
    !desktopVersion ||
    !terminalBrowserVersion ||
    !desktopListeningPids.includes(status.app.pid) ||
    !terminalListeningPids.includes(status.app.pid)
  ) {
    throw new DevSessionError("Electron CDP ownership handshake failed", 4, {
      instanceId,
      statusPath,
      desktopListeningPids,
      terminalListeningPids,
      expectedPid: status.app.pid,
    });
  }
  processInfo.processSignature = readProcessSignature(processInfo.pid);
  const serviceInstanceId = `${channel}:${instanceId}:${status.app.pid}`;
  const electron = {
    ownership: "dedicated",
    serviceInstanceId,
    ownerDevSessionId: sessionId,
    instanceId,
    channel,
    pid: status.app.pid,
    sourceRevision: revision,
    userDataDir,
    statusPath,
    desktopCdpEndpoint,
    terminalBrowserCdpEndpoint,
    frontendUrl: frontend.url,
    bundleDir,
    process: processInfo,
  };
  return {
    electron,
    beta:
      channel === "beta"
        ? {
            ownership: "dedicated",
            serviceInstanceId: `beta:${instanceId}`,
            ownerDevSessionId: sessionId,
            instanceId,
            channel,
            pid: status.app.pid,
            sourceRevision: revision,
            userDataDir,
            statusPath,
            process: processInfo,
          }
        : { ownership: "disabled" },
    cdp: {
      desktop: {
        ownership: "dedicated",
        serviceInstanceId: `cdp:${instanceId}:desktop`,
        ownerDevSessionId: sessionId,
        instanceId,
        pid: status.app.pid,
        endpoint: desktopCdpEndpoint,
        sourceRevision: revision,
      },
      terminalBrowser: {
        ownership: "dedicated",
        serviceInstanceId: `cdp:${instanceId}:terminal-browser`,
        ownerDevSessionId: sessionId,
        instanceId,
        pid: status.app.pid,
        endpoint: terminalBrowserCdpEndpoint,
        sourceRevision: revision,
      },
    },
  };
}

async function startDedicatedBeta({
  sourceRoot,
  sessionId,
  instanceId,
  revision,
  desktopCdpPort,
  terminalBrowserCdpPort,
  sharedBackend,
  sharedAppServer,
  requestedSharedBackend,
  requestedSharedAppServer,
  onSpawn,
}) {
  const paths = resolveBetaPaths(
    sourceRoot,
    os.homedir(),
    instanceId,
    sessionId,
    { desktopCdpPort, terminalBrowserCdpPort },
  );
  const controlArgs = [
    path.join(sourceRoot, "scripts", "runweave-beta.mjs"),
    "update",
    "--instance",
    instanceId,
    "--dev-session",
    sessionId,
    "--desktop-cdp-port",
    String(desktopCdpPort),
    "--terminal-browser-cdp-port",
    String(terminalBrowserCdpPort),
    "--mode",
    "app",
    "--app-server",
    sharedAppServer ? "skip" : "update",
  ];
  const launchEnv = { ...process.env };
  launchEnv.RUNWEAVE_MANAGES_PACKAGED_BACKEND = sharedBackend
    ? "false"
    : "true";
  for (const key of [
    "RUNWEAVE_EXPECTED_BACKEND_ID",
    "RUNWEAVE_SHARED_BACKEND_PID",
    "RUNWEAVE_SHARED_BACKEND_PROFILE_DIR",
  ]) {
    delete launchEnv[key];
  }
  if (!sharedBackend) {
    delete launchEnv.RUNWEAVE_BACKEND_URL;
  }
  for (const key of [
    "RUNWEAVE_APP_SERVER_DISCOVERY",
    "RUNWEAVE_APP_SERVER_TOKEN",
    "RUNWEAVE_APP_SERVER_URL",
    "RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH",
    "RUNWEAVE_SHARED_APP_SERVER_PID",
  ]) {
    delete launchEnv[key];
  }
  if (sharedBackend) {
    Object.assign(launchEnv, {
      RUNWEAVE_MANAGES_PACKAGED_BACKEND: "false",
      RUNWEAVE_BACKEND_URL: sharedBackend.url,
      RUNWEAVE_EXPECTED_BACKEND_ID: sharedBackend.serviceInstanceId,
      RUNWEAVE_SHARED_BACKEND_PID: String(sharedBackend.pid),
      RUNWEAVE_SHARED_BACKEND_PROFILE_DIR: path.dirname(
        sharedBackend.lockPath,
      ),
    });
  }
  if (sharedAppServer) {
    Object.assign(launchEnv, {
      RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
      RUNWEAVE_APP_SERVER_HOME: path.dirname(sharedAppServer.lockPath),
      RUNWEAVE_APP_SERVER_TOKEN: readFileSync(
        sharedAppServer.tokenPath,
        "utf8",
      ).trim(),
      RUNWEAVE_APP_SERVER_URL: sharedAppServer.url,
      RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH: sharedAppServer.lockPath,
      RUNWEAVE_SHARED_APP_SERVER_PID: String(sharedAppServer.pid),
    });
  }
  const stopBetaControl = async () => {
    await execFileAsync(
      process.execPath,
      [
        path.join(sourceRoot, "scripts", "runweave-beta.mjs"),
        "stop",
        "--instance",
        instanceId,
        "--dev-session",
        sessionId,
      ],
      { cwd: sourceRoot, encoding: "utf8" },
    );
  };
  try {
    await execFileAsync(process.execPath, controlArgs, {
      cwd: sourceRoot,
      encoding: "utf8",
      env: launchEnv,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
  } catch (error) {
    throw new DevSessionError("Beta instance update/start failed", 1, {
      instanceId,
      stderr: error?.stderr?.slice(-4_000) ?? null,
    });
  }
  const status = await buildBetaStatus(paths);
  if (
    status.instanceId !== instanceId ||
    status.devSessionId !== sessionId ||
    status.source.gitHead !== revision ||
    !status.desktop.healthy ||
    !status.backend.healthy ||
    !status.appServer.healthy ||
    !status.cdp.desktop.healthy ||
    !status.cdp.terminalBrowser.healthy
  ) {
    await stopBetaControl().catch(() => undefined);
    throw new DevSessionError("Beta instance readiness identity failed", 4, {
      instanceId,
      status,
    });
  }
  const processInfo = {
    pid: status.desktop.pid,
    command: `open -n ${paths.appPath}`,
    cwd: sourceRoot,
    startedAt: new Date().toISOString(),
    processSignature: readProcessSignature(status.desktop.pid),
    logPath: status.update.logPath,
  };
  onSpawn(processInfo, stopBetaControl);
  const backendLockPath =
    sharedBackend?.lockPath ?? path.join(paths.profileDir, "backend.lock.json");
  const appServerLockPath =
    sharedAppServer?.lockPath ?? paths.appServerLockPath;
  const [backendLock, backendHealth, appServerLock, appServerHealth] =
    await Promise.all([
      readJson(backendLockPath),
      fetchHealthJson(`${status.backend.baseUrl}/health`),
      readJson(appServerLockPath),
      fetchHealthJson(`${status.appServer.baseUrl}/healthz`),
    ]);
  if (
    !backendLock ||
    backendHealth?.status !== "ok" ||
    !appServerLock ||
    appServerHealth?.ok !== true
  ) {
    await stopBetaControl().catch(() => undefined);
    throw new DevSessionError(
      "Beta component ownership handshake failed",
      4,
      { instanceId },
    );
  }
  const electron = {
    ownership: "dedicated",
    serviceInstanceId: `beta:${instanceId}:${status.desktop.pid}`,
    ownerDevSessionId: sessionId,
    instanceId,
    channel: "beta",
    pid: status.desktop.pid,
    sourceRevision: revision,
    userDataDir: status.desktop.userDataPath,
    statusPath: status.desktop.statusPath,
    desktopCdpEndpoint: status.cdp.desktop.endpoint,
    terminalBrowserCdpEndpoint: status.cdp.terminalBrowser.endpoint,
    frontendUrl: "runweave://app",
    appPath: status.desktop.appPath,
    betaControl: {
      command: process.execPath,
      args: [
        path.join(sourceRoot, "scripts", "runweave-beta.mjs"),
        "stop",
        "--instance",
        instanceId,
        "--dev-session",
        sessionId,
      ],
      cwd: sourceRoot,
    },
    process: processInfo,
  };
  const frontend = {
    ownership: "dedicated",
    serviceInstanceId: `beta-renderer:${instanceId}:${status.desktop.pid}`,
    ownerDevSessionId: sessionId,
    pid: status.desktop.pid,
    url: "runweave://app/index.html",
    sourceRevision: revision,
    expectedBackendServiceInstanceId: backendHealth.serviceInstanceId,
    process: processInfo,
  };
  const backend = sharedBackend ?? {
    ownership: "dedicated",
    serviceInstanceId: backendHealth.serviceInstanceId,
    ownerDevSessionId: sessionId,
    pid: backendLock.pid,
    url: status.backend.baseUrl,
    resourceNamespace: backendHealth.resourceNamespace,
    protocolVersion: backendHealth.protocolVersion,
    capabilities: backendHealth.capabilities,
    sourceRevision: revision,
    profileDir: paths.profileDir,
    lockPath: backendLockPath,
    lockStartedAt: backendLock.startedAt,
    lockCwd: backendLock.cwd,
    process: {
      pid: backendLock.pid,
      command: "Runweave Beta packaged backend",
      cwd: backendLock.cwd,
      startedAt: backendLock.startedAt,
      processSignature: readProcessSignature(backendLock.pid),
      logPath: status.update.logPath,
    },
  };
  const appServer = sharedAppServer ?? {
    ownership: "dedicated",
    serviceInstanceId: appServerHealth.serviceInstanceId,
    ownerDevSessionId: sessionId,
    pid: appServerLock.pid,
    url: status.appServer.baseUrl,
    protocolVersion: appServerHealth.protocolVersion,
    capabilities: appServerHealth.capabilities,
    sourceRevision: revision,
    homeDir: paths.appServerHome,
    lockPath: appServerLockPath,
    lockStartedAt: appServerLock.startedAt,
    lockIdentity: {
      entry: appServerLock.entry,
      releaseId: appServerLock.releaseId ?? null,
      runtimeRoot: appServerLock.runtimeRoot ?? null,
    },
    tokenPath: path.join(paths.appServerHome, "app-server-token"),
    process: {
      pid: appServerLock.pid,
      command: "Runweave Beta App Server",
      cwd: appServerLock.runtimeRoot ?? paths.appServerHome,
      startedAt: appServerLock.startedAt,
      processSignature: readProcessSignature(appServerLock.pid),
      logPath: paths.appServerLogPath,
    },
  };
  const [backendInspection, appServerInspection] = await Promise.all([
    inspectBackendHandshake(backend),
    inspectAppServerHandshake(appServer),
  ]);
  if (!backendInspection.ok || !appServerInspection.ok) {
    await stopBetaControl().catch(() => undefined);
    throw new DevSessionError("Beta component identity drifted", 4, {
      instanceId,
      backend: backendInspection.reason,
      appServer: appServerInspection.reason,
    });
  }
  if (!sharedBackend && requestedSharedBackend) {
    backend.ownershipUpgradeReason =
      "Default Backend was unavailable; upgraded to dedicated Beta Backend";
  }
  if (!sharedAppServer && requestedSharedAppServer) {
    appServer.ownershipUpgradeReason =
      "Default App Server was unavailable; upgraded to dedicated Beta App Server";
  }
  return {
    frontend,
    backend,
    appServer,
    electron,
    beta: {
      ...electron,
      serviceInstanceId: `beta-control:${instanceId}`,
    },
    cdp: {
      desktop: {
        ownership: "dedicated",
        serviceInstanceId: `cdp:${instanceId}:desktop`,
        ownerDevSessionId: sessionId,
        instanceId,
        pid: status.desktop.pid,
        endpoint: status.cdp.desktop.endpoint,
        sourceRevision: revision,
      },
      terminalBrowser: {
        ownership: "dedicated",
        serviceInstanceId: `cdp:${instanceId}:terminal-browser`,
        ownerDevSessionId: sessionId,
        instanceId,
        pid: status.desktop.pid,
        endpoint: status.cdp.terminalBrowser.endpoint,
        sourceRevision: revision,
      },
    },
  };
}

export async function startSessionServices({
  plan,
  sessionId,
  revision,
  paths,
}) {
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  const reservedPorts = new Set();
  const portLeases = [];
  const reservePort = async (startPort) => {
    let candidate = startPort;
    while (candidate <= 65_535) {
      if (reservedPorts.has(candidate)) {
        candidate += 1;
        continue;
      }
      const lease = await acquireServicePortLease(
        paths.root,
        candidate,
        sessionId,
      );
      if (!lease) {
        candidate += 1;
        continue;
      }
      const availablePort = await resolvePort(candidate, {
        reservedPorts,
        host: "127.0.0.1",
      });
      if (availablePort !== candidate) {
        await lease.release();
        candidate = availablePort;
        continue;
      }
      reservedPorts.add(candidate);
      portLeases.push(lease);
      return candidate;
    }
    throw new DevSessionError(`no service port available from ${startPort}`, 1);
  };
  const startedProcesses = [];
  const onSpawn = (processInfo, cleanup = null) => {
    startedProcesses.push({ processInfo, cleanup });
  };
  try {
    if (plan.profile === "beta") {
      const requestedSharedBackend =
        plan.services.backend.ownership === "shared-declared";
      const requestedSharedAppServer =
        plan.services.appServer.ownership === "shared-declared";
      const requiredSharedBackend =
        requestedSharedBackend &&
        plan.services.backend.selectedBy === "explicit-service";
      const requiredSharedAppServer =
        requestedSharedAppServer &&
        plan.services.appServer.selectedBy === "explicit-service";
      let sharedAppServer = requestedSharedAppServer
        ? await resolveSharedAppServer(revision, {
            required: requiredSharedAppServer,
          })
        : null;
      let sharedBackend = requestedSharedBackend
        ? await resolveSharedBackend(plan.sourceRoot, revision, {
            required: requiredSharedBackend,
          })
        : null;
      if (
        requestedSharedBackend &&
        requestedSharedAppServer &&
        !requiredSharedBackend &&
        !requiredSharedAppServer &&
        (!sharedBackend || !sharedAppServer)
      ) {
        sharedBackend = null;
        sharedAppServer = null;
      }
      const desktopCdpPort = await reservePort(9335);
      const terminalBrowserCdpPort = await reservePort(9336);
      return await startDedicatedBeta({
        sourceRoot: plan.sourceRoot,
        sessionId,
        instanceId: plan.targetEnvironment.instanceId ?? sessionId,
        revision,
        desktopCdpPort,
        terminalBrowserCdpPort,
        sharedBackend,
        sharedAppServer,
        requestedSharedBackend,
        requestedSharedAppServer,
        onSpawn,
      });
    }
    const requiredSharedBackend =
      plan.services.backend.ownership === "shared-declared" &&
      plan.services.backend.selectedBy === "explicit-service";
    let backend = requiredSharedBackend
      ? await resolveSharedBackend(plan.sourceRoot, revision, {
          required: true,
        })
      : null;
    let appServer = null;
    if (plan.services.appServer.ownership === "shared-declared") {
      appServer = await resolveSharedAppServer(revision, {
        required: plan.services.appServer.selectedBy === "explicit-service",
      });
    }
    if (
      plan.services.appServer.ownership === "dedicated" ||
      (plan.services.appServer.ownership === "shared-declared" && !appServer)
    ) {
      const port = await reservePort(6100);
      appServer = await startDedicatedAppServer({
        sourceRoot: plan.sourceRoot,
        sessionId,
        revision,
        paths,
        port,
        onSpawn,
      });
      appServer.ownershipUpgradeReason =
        plan.services.appServer.ownership === "shared-declared"
          ? "Default App Server was unavailable; upgraded to dedicated"
          : undefined;
    }
    appServer ??= { ownership: "disabled" };

    if (
      plan.services.backend.ownership === "shared-declared" &&
      !backend
    ) {
      backend = await resolveSharedBackend(plan.sourceRoot, revision);
    }
    if (plan.services.backend.ownership === "dedicated" || !backend) {
      const port = await reservePort(5000);
      backend = await startDedicatedBackend({
        sourceRoot: plan.sourceRoot,
        sessionId,
        revision,
        paths,
        port,
        appServer,
        onSpawn,
      });
      backend.ownershipUpgradeReason =
        plan.services.backend.ownership === "shared-declared"
          ? "Default Backend was unavailable; upgraded to dedicated"
          : undefined;
    }

    const frontendPort = await reservePort(5173);
    const frontend = await startDedicatedFrontend({
      sourceRoot: plan.sourceRoot,
      sessionId,
      revision,
      paths,
      port: frontendPort,
      backend,
      onSpawn,
    });
    let desktop = {
      electron: { ownership: "disabled" },
      beta: { ownership: "disabled" },
      cdp: {
        desktop: { ownership: "disabled" },
        terminalBrowser: { ownership: "disabled" },
      },
    };
    if (plan.services.electron.ownership === "dedicated") {
      const desktopCdpPort = await reservePort(9223);
      const terminalBrowserCdpPort = await reservePort(9224);
      desktop = await startDedicatedElectron({
        sourceRoot: plan.sourceRoot,
        sessionId,
        instanceId: plan.targetEnvironment.instanceId ?? sessionId,
        revision,
        paths,
        frontend,
        backend,
        appServer,
        desktopCdpPort,
        terminalBrowserCdpPort,
        channel: plan.profile === "beta" ? "beta" : "stable",
        onSpawn,
      });
    }
    return {
      frontend,
      backend,
      appServer,
      electron: desktop.electron,
      beta: desktop.beta,
      cdp: desktop.cdp,
    };
  } catch (error) {
    for (const started of startedProcesses.reverse()) {
      await (started.cleanup
        ? started.cleanup()
        : stopSpawnedProcess(started.processInfo)
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    for (const lease of portLeases.reverse()) {
      await lease.release();
    }
  }
}

export async function assertSessionServicesStoppable(services) {
  const inspection = await inspectSessionServices(services);
  const staleOwnedServices = [
    "frontend",
    "backend",
    "appServer",
    "electron",
    "beta",
  ].filter(
    (serviceName) =>
      services[serviceName]?.ownership === "dedicated" &&
      inspection.services[serviceName]?.health === "stale",
  );
  if (staleOwnedServices.length > 0) {
    throw new DevSessionError(
      "owned service identity drifted; refusing to stop",
      5,
      { staleOwnedServices, services: inspection.services },
    );
  }
  return inspection;
}

export async function stopSessionServices(
  services,
  { identityVerified = false } = {},
) {
  if (!identityVerified) {
    await assertSessionServicesStoppable(services);
  }
  const ordered = [
    services.electron,
    services.frontend,
    services.backend,
    services.appServer,
  ];
  for (const service of ordered) {
    if (service?.ownership === "dedicated") {
      if (service.betaControl) {
        await execFileAsync(service.betaControl.command, service.betaControl.args, {
          cwd: service.betaControl.cwd,
          encoding: "utf8",
        });
      } else {
        await stopOwnedProcess(service.process);
      }
    }
  }
}

export async function cleanupStaleSessionServices(services) {
  const inspection = await inspectSessionServices(services);
  const cleanedServices = structuredClone(inspection.services);
  const stoppedServices = [];
  const skippedStaleServices = [];
  const orderedServiceNames = [
    "electron",
    "frontend",
    "backend",
    "appServer",
  ];
  for (const serviceName of orderedServiceNames) {
    const originalService = services[serviceName];
    const inspectedService = cleanedServices[serviceName];
    if (originalService?.ownership !== "dedicated") {
      continue;
    }
    if (inspectedService?.health !== "live") {
      inspectedService.cleanupStatus = "skipped-stale-identity";
      skippedStaleServices.push({
        service: serviceName,
        reason: inspectedService?.healthFailureReason ?? "identity drifted",
        logPath: originalService.process?.logPath ?? null,
      });
      continue;
    }
    if (originalService.betaControl) {
      await execFileAsync(
        originalService.betaControl.command,
        originalService.betaControl.args,
        {
          cwd: originalService.betaControl.cwd,
          encoding: "utf8",
        },
      );
    } else {
      await stopOwnedProcess(originalService.process);
    }
    inspectedService.cleanupStatus = "stopped-identity-verified";
    stoppedServices.push(serviceName);
  }
  return {
    services: cleanedServices,
    summary: {
      stoppedServices,
      skippedStaleServices,
      sharedServicesPreserved: Object.keys(services).filter(
        (serviceName) => services[serviceName]?.ownership === "shared-declared",
      ),
    },
  };
}

export async function inspectSessionServices(services) {
  const betaReconciliation = await reconcileBetaSessionServices(services);
  const inspected = betaReconciliation?.services ?? structuredClone(services);
  let stale = false;
  for (const serviceName of [
    "frontend",
    "backend",
    "appServer",
    "electron",
    "beta",
  ]) {
    const service = inspected[serviceName];
    if (!service || service.ownership === "disabled") {
      continue;
    }
    let inspection;
    if (serviceName === "backend") {
      inspection = await inspectBackendHandshake(service);
    } else if (serviceName === "appServer") {
      inspection = await inspectAppServerHandshake(service);
    } else if (serviceName === "electron") {
      inspection = await inspectElectronHandshake(service);
    } else {
      const ok =
        service.ownership === "dedicated" &&
        processIdentityMatches(service.process);
      inspection = {
        ok,
        reason: ok ? null : "owned process identity drifted",
      };
    }
    service.health = inspection.ok ? "live" : "stale";
    service.healthFailureReason = inspection.reason;
    if (!inspection.ok) {
      stale = true;
    }
  }
  return {
    services: inspected,
    stale,
    reconciled: Boolean(betaReconciliation),
    sourceRevision: betaReconciliation?.sourceRevision ?? null,
    sourceDirty: betaReconciliation?.sourceDirty ?? null,
  };
}

export async function resolveOpenTarget(manifest, surface) {
  const inspection = await inspectSessionServices(manifest.services);
  if (inspection.stale) {
    throw new DevSessionError("dev session has stale owned services", 5, {
      services: inspection.services,
    });
  }
  if (surface === "web") {
    const frontend = inspection.services.frontend;
    if (!frontend?.url) {
      throw new DevSessionError("web surface is disabled", 4);
    }
    return {
      devSessionId: manifest.devSessionId,
      surface,
      serviceInstanceId: frontend.serviceInstanceId,
      endpoint: assertLoopbackUrl(frontend.url, "frontend URL"),
      pid: frontend.pid,
      revision: frontend.sourceRevision,
      health: "ready",
      suggestedPlaywrightSession: `${manifest.devSessionId}-web`,
    };
  }
  const cdp =
    surface === "desktop"
      ? inspection.services.cdp?.desktop
      : inspection.services.cdp?.terminalBrowser;
  if (!cdp?.endpoint) {
    throw new DevSessionError(`${surface} surface is disabled`, 4);
  }
  return {
    devSessionId: manifest.devSessionId,
    surface,
    serviceInstanceId: cdp.serviceInstanceId,
    endpoint: assertLoopbackUrl(cdp.endpoint, `${surface} CDP endpoint`),
    pid: cdp.pid,
    revision: cdp.sourceRevision,
    health: "ready",
    suggestedPlaywrightSession: `${manifest.devSessionId}-${surface}`,
  };
}

export async function resolveSourceRevision(sourceRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}
