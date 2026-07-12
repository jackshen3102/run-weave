import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

import { resolvePort } from "../../dev.mjs";
import { DevSessionError, assertLoopbackUrl } from "./contracts.mjs";
import { acquireServicePortLease } from "./registry.mjs";
import {
  inspectAppServerHandshake,
  inspectBackendHandshake,
  inspectElectronHandshake,
  processIdentityMatches,
  reconcileBetaSessionServices,
} from "./service-runtime.mjs";
import {
  resolveSharedAppServer,
  resolveSharedBackend,
  stopOwnedProcess,
  stopSpawnedProcess,
} from "./shared-services.mjs";
import {
  startDedicatedAppServer,
  startDedicatedBackend,
  startDedicatedElectron,
  startDedicatedFrontend,
} from "./dedicated-services.mjs";
import { startDedicatedBeta } from "./beta-service.mjs";

const execFileAsync = promisify(execFile);

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

export async function cleanupStaleSessionServices(
  services,
  { serviceNames = null } = {},
) {
  const inspection = await inspectSessionServices(services);
  const cleanedServices = structuredClone(
    serviceNames ? services : inspection.services,
  );
  const stoppedServices = [];
  const skippedStaleServices = [];
  const orderedServiceNames = [
    "electron",
    "frontend",
    "backend",
    "appServer",
  ];
  for (const serviceName of orderedServiceNames) {
    if (serviceNames && !serviceNames.includes(serviceName)) {
      continue;
    }
    const originalService = services[serviceName];
    const inspectedService = structuredClone(
      inspection.services[serviceName],
    );
    if (originalService?.ownership !== "dedicated") {
      continue;
    }
    cleanedServices[serviceName] = inspectedService;
    if (inspectedService?.health !== "live") {
      if (
        !originalService.betaControl &&
        processIdentityMatches(originalService.process)
      ) {
        await stopOwnedProcess(originalService.process);
        inspectedService.cleanupStatus =
          "stopped-owner-process-identity-verified";
        stoppedServices.push(serviceName);
        continue;
      }
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
