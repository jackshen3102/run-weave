import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  bundleElectron,
  createBackendEnv,
  createFrontendEnv,
  resolveElectronBin,
} from "../../dev.mjs";
import { DevSessionError } from "./contracts.mjs";
import { listManifestsForSource } from "./registry.mjs";
import {
  hasCapabilities,
  isProcessLive,
  readJson,
  readProcessSignature,
  resolveListeningPids,
  spawnDetached,
  waitForDesktopStatus,
  waitForJson,
  waitForPage,
} from "./service-runtime.mjs";
import { buildAgentTeamFixtureEnvironment } from "./agent-team-fixture-scope.mjs";

export async function startDedicatedAppServer({
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

export async function startDedicatedBackend({
  sourceRoot,
  sessionId,
  revision,
  paths,
  port,
  appServer,
  fixtureScope = null,
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
      ...createBackendEnv({
        baseEnv: backendBaseEnv,
        backendPort: port,
        sourceRoot,
      }),
      RUNWEAVE_DEV_BROWSER_PROFILE_DIR: profileDir,
      BROWSER_PROFILE_DIR: profileDir,
      RUNWEAVE_DEV_SESSION_ID: sessionId,
      RUNWEAVE_SOURCE_REVISION: revision,
      RUNWEAVE_RESOURCE_NAMESPACE: namespace,
      ...buildAgentTeamFixtureEnvironment(fixtureScope, {
        ownsTerminalSession: true,
      }),
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

export async function detectDedicatedBackendProfileConflict({
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

export async function startDedicatedFrontend({
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

export async function startDedicatedElectron({
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
