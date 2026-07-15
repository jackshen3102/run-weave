import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { DevSessionError, assertLoopbackUrl } from "./contracts.mjs";
import {
  buildBetaStatus,
  resolveBetaPaths,
} from "../runweave-beta-state.mjs";

const execFileAsync = promisify(execFile);
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 200;

export function isProcessLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessSignature(pid) {
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

export function spawnDetached({ name, command, args, cwd, env, logPath }) {
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

export async function waitForJson(url, predicate, processInfo, options = {}) {
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

export async function waitForPage(url, processInfo) {
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

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function fetchHealthJson(url) {
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

export async function resolveListeningPids(endpoint) {
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

export async function endpointHasPage(endpoint, expectedUrl) {
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

export function hasCapabilities(actual, expected) {
  return (
    Array.isArray(actual) &&
    expected.every((capability) => actual.includes(capability))
  );
}

export function processIdentityMatches(processInfo) {
  return Boolean(
    processInfo?.pid &&
    isProcessLive(processInfo.pid) &&
    processInfo.processSignature &&
    readProcessSignature(processInfo.pid) === processInfo.processSignature,
  );
}

export async function inspectBackendHandshake(service) {
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

export async function inspectAppServerHandshake(service) {
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

export async function inspectElectronHandshake(service) {
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

export function resolveBetaReconciliationPaths(services) {
  const beta = services.beta;
  const pooledBeta = /^pool-0[1-5]$/.test(beta?.instanceId ?? "");
  const desktopEndpoint = services.cdp?.desktop?.endpoint;
  const terminalBrowserEndpoint = services.cdp?.terminalBrowser?.endpoint;
  if (
    beta?.ownership !== "dedicated" ||
    beta.channel !== "beta" ||
    !beta.instanceId ||
    (pooledBeta &&
      (beta.slotId !== beta.instanceId ||
        typeof beta.leaseNonce !== "string" ||
        !beta.leaseNonce)) ||
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

export async function reconcileBetaSessionServices(services) {
  const paths = resolveBetaReconciliationPaths(services);
  if (!paths) {
    return null;
  }
  const beta = services.beta;
  const pooledBeta = /^pool-0[1-5]$/.test(beta.instanceId);
  const [status, desktopState] = await Promise.all([
    buildBetaStatus(paths),
    readJson(paths.desktopStatusPath),
  ]);
  const revision = status.source.gitHead;
  if (
    status.channel !== "beta" ||
    status.instanceId !== beta.instanceId ||
    (pooledBeta &&
      (status.slotId !== beta.slotId ||
        status.poolPolicy !== "fixed-pool-v1")) ||
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

export async function waitForDesktopStatus(statusPath, predicate, processInfo) {
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
