#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  DEV_SESSION_SCHEMA_VERSION,
  DevSessionError,
  assertDevSessionId,
  assertSurface,
  publicManifest,
} from "./contracts.mjs";
import { buildDevSessionPlan, collectChangedFiles } from "./planner.mjs";
import {
  readManifest,
  resolveManifestCandidate,
  withSessionLock,
  writeManifest,
} from "./registry.mjs";
import {
  assertSessionServicesStoppable,
  cleanupStaleSessionServices,
  inspectSessionServices,
  resolveOpenTarget,
  resolveSourceRevision,
  startSessionServices,
  stopSessionServices,
} from "./services.mjs";
import { processIdentityMatches } from "./service-runtime.mjs";
import {
  acquireBetaSlotLease,
  applyBetaSlotRetention,
  assertBetaPoolDiskBudget,
  assertBetaSlotLease,
  inspectBetaSlotCapacity,
  recordBetaSlotRelease,
  releaseBetaSlotLease,
  resetBetaSlotMutableState,
  runBetaPoolJanitor,
} from "./beta-slot-pool.mjs";

function parseArgs(argv) {
  const command = argv[0] ?? "start";
  if (!new Set(["start", "status", "open", "stop"]).has(command)) {
    throw new DevSessionError(`unsupported command: ${command}`, 2);
  }
  const options = {
    command,
    changedFiles: [],
    serviceOverrides: [],
    json: false,
    dryRun: false,
    cleanupStale: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--cleanup-stale") {
      options.cleanupStale = true;
      continue;
    }
    const valueOptions = new Map([
      ["--profile", "profile"],
      ["--session", "sessionId"],
      ["--surface", "surface"],
      ["--changed-file", "changedFiles"],
      ["--service", "serviceOverrides"],
      ["--instance", "instanceId"],
    ]);
    const key = valueOptions.get(arg);
    if (!key) {
      throw new DevSessionError(`unknown argument: ${arg}`, 2);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DevSessionError(`missing value for ${arg}`, 2);
    }
    index += 1;
    if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = value;
    }
  }
  if (options.cleanupStale && command !== "stop") {
    throw new DevSessionError("--cleanup-stale is only valid with stop", 2);
  }
  return options;
}

function createReadableSessionId() {
  const suffix = randomBytes(3).toString("hex");
  return `dvs-${suffix}`;
}

function createManifest({
  plan,
  sessionId,
  revision,
  state,
  services,
  failure = null,
}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: DEV_SESSION_SCHEMA_VERSION,
    devSessionId: sessionId,
    state,
    profile: plan.profile,
    selectedBy: plan.selectedBy,
    controlPlane: {
      appChannel: "stable",
      sourceRoot: plan.sourceRoot,
      originTerminalSessionId:
        process.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim() || null,
      agentTeamRunId: process.env.RUNWEAVE_AGENT_TEAM_RUN_ID?.trim() || null,
    },
    targetEnvironment: plan.targetEnvironment,
    source: {
      root: plan.sourceRoot,
      revision,
      dirty: plan.changedFiles.length > 0,
    },
    services,
    impacts: plan.impacts,
    createdAt: now,
    updatedAt: now,
    failure,
  };
}

function updateManifest(manifest, fields) {
  return {
    ...manifest,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
}

function retainsBetaSlotLease(manifest) {
  return Boolean(
    manifest.profile === "beta" &&
      manifest.targetEnvironment.betaSlot?.assignedSlotId &&
      manifest.state !== "stopped" &&
      !(
        manifest.state === "failed" &&
        manifest.failure?.leaseRetained === false
      ),
  );
}

function attachBetaSlotToPlannedServices(services, slotId, leaseNonce) {
  const next = structuredClone(services);
  for (const serviceName of [
    "frontend",
    "backend",
    "appServer",
    "electron",
    "beta",
  ]) {
    next[serviceName] = {
      ...next[serviceName],
      slotId,
      leaseNonce,
    };
  }
  next.cdp = {
    desktop: { ...next.cdp.desktop, slotId, leaseNonce },
    terminalBrowser: { ...next.cdp.terminalBrowser, slotId, leaseNonce },
  };
  return next;
}

function buildStaleRecovery(sessionId, services, staleOwnedServices) {
  const staleServices = staleOwnedServices.map((serviceName) => ({
    service: serviceName,
    reason: services[serviceName]?.healthFailureReason ?? "identity drifted",
    logPath: services[serviceName]?.process?.logPath ?? null,
  }));
  return {
    action: "cleanup-stale-session",
    command: `pnpm dev:stop --session ${sessionId} --cleanup-stale --json`,
    steps: [
      "Review each stale service reason and logPath.",
      "Verify stale PIDs are gone or belong to an unrelated process; do not kill identity-mismatched PIDs.",
      "Run the cleanup command to stop only identity-verified dedicated services and mark the Session stopped.",
    ],
    safety:
      "Cleanup skips stale identities and shared services, and only operates on resources recorded by this Session manifest.",
    staleServices,
  };
}

function printResult(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (value.endpoint) {
    process.stdout.write(`${value.endpoint}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readOptionalManifest(sessionId) {
  try {
    return await readManifest(sessionId);
  } catch (error) {
    if (error instanceof DevSessionError && error.exitCode === 3) {
      return null;
    }
    throw error;
  }
}

async function runStart(options, sourceRoot) {
  const changedFiles = await collectChangedFiles(
    sourceRoot,
    options.changedFiles,
  );
  const plan = buildDevSessionPlan({
    sourceRoot,
    changedFiles,
    explicitProfile: options.profile,
    explicitSurface: options.surface,
    explicitInstance: options.instanceId,
    serviceOverrides: options.serviceOverrides,
  });
  if (options.dryRun) {
    const dryRunPlan =
      plan.profile === "beta"
        ? {
            ...plan,
            targetEnvironment: {
              ...plan.targetEnvironment,
              betaSlot: {
                ...plan.targetEnvironment.betaSlot,
                capacitySnapshot: await inspectBetaSlotCapacity(),
              },
            },
          }
        : plan;
    printResult({ dryRun: true, ...dryRunPlan }, options.json);
    return;
  }
  if (!plan.executable) {
    throw new DevSessionError(
      `profile ${plan.profile} is not executable in this rollout`,
      4,
      {
        profile: plan.profile,
        unsupportedServices: plan.unsupportedServices,
        noProcessesStarted: true,
      },
    );
  }
  const sessionId = assertDevSessionId(
    options.sessionId ?? createReadableSessionId(),
  );
  const revision = await resolveSourceRevision(sourceRoot);
  if (plan.profile === "beta") {
    await runBetaPoolJanitor();
  }
  await withSessionLock(sessionId, async (paths) => {
    let manifestCreated = false;
    let slotLease = null;
    let diskSummary = null;
    let startedServices = null;
    try {
      const existing = await readOptionalManifest(sessionId);
      if (existing && existing.state !== "stopped") {
        throw new DevSessionError(
          `dev session must be stopped before its id can be reused: ${sessionId}`,
          5,
          {
            state: existing.state,
          },
        );
      }
      let manifest = createManifest({
        plan,
        sessionId,
        revision,
        state: "planned",
        services: plan.services,
      });
      await writeManifest(manifest);
      manifestCreated = true;
      if (plan.profile === "beta") {
        slotLease = await acquireBetaSlotLease({
          requestedSlotId: plan.targetEnvironment.betaSlot.requestedSlotId,
          ownerSessionId: sessionId,
          ownerSourceRoot: sourceRoot,
          ownerRevision: revision,
          ownerManifestPath: paths.manifestPath,
        });
        const assignedSlotId = slotLease.lease.slotId;
        plan.targetEnvironment = {
          ...plan.targetEnvironment,
          instanceId: assignedSlotId,
          betaSlot: {
            ...plan.targetEnvironment.betaSlot,
            assignedSlotId,
            leaseNonce: slotLease.lease.leaseNonce,
          },
        };
        plan.services = attachBetaSlotToPlannedServices(
          plan.services,
          assignedSlotId,
          slotLease.lease.leaseNonce,
        );
        manifest = updateManifest(manifest, {
          targetEnvironment: plan.targetEnvironment,
          services: plan.services,
        });
      }
      manifest = updateManifest(manifest, { state: "starting" });
      await writeManifest(manifest);
      if (plan.profile === "beta") {
        const startRetention = await applyBetaSlotRetention({
          slotId: slotLease.lease.slotId,
        });
        diskSummary = await assertBetaPoolDiskBudget({
          sourceRoot,
          slotId: slotLease.lease.slotId,
          cleanedBytes: startRetention.cleanedBytes,
        });
      }
      startedServices = await startSessionServices({
        plan,
        sessionId,
        revision,
        paths,
      });
      manifest = updateManifest(manifest, {
        state: "ready",
        services: startedServices,
      });
      await writeManifest(manifest);
      printResult(publicManifest(manifest), options.json);
    } catch (error) {
      const existing = manifestCreated
        ? await readOptionalManifest(sessionId)
        : null;
      if (existing && existing.state !== "ready") {
        let resetFailure =
          error instanceof DevSessionError && error.details?.resetUnsafe
            ? new Error("identity-safe start cleanup did not complete")
            : null;
        if (startedServices && !resetFailure) {
          try {
            await stopSessionServices(startedServices);
          } catch (cleanupError) {
            resetFailure = cleanupError;
          }
        }
        if (slotLease && !resetFailure) {
          try {
            const cleanupSummary = await resetBetaSlotMutableState({
              slotId: slotLease.lease.slotId,
            });
            const retention = await applyBetaSlotRetention({
              slotId: slotLease.lease.slotId,
            });
            await recordBetaSlotRelease({
              slotId: slotLease.lease.slotId,
              revision,
              cleanupSummary: { ...cleanupSummary, retention },
              diskSummary,
            });
          } catch (cleanupError) {
            resetFailure = cleanupError;
          }
        }
        const failedManifest = updateManifest(existing, {
          state: resetFailure ? "stale" : "failed",
          ...(startedServices ? { services: startedServices } : {}),
          failure: {
            message: error instanceof Error ? error.message : String(error),
            exitCode: error instanceof DevSessionError ? error.exitCode : 1,
            ...(resetFailure
              ? {
                  resetFailure:
                    resetFailure instanceof Error
                      ? resetFailure.message
                      : String(resetFailure),
                  leaseRetained: true,
                }
              : { leaseRetained: false }),
          },
        });
        await writeManifest(failedManifest);
        if (slotLease && !resetFailure) {
          await releaseBetaSlotLease(slotLease);
        }
      }
      throw error;
    }
  });
}

async function runStatus(options, sourceRoot) {
  const candidate = await resolveManifestCandidate({
    sessionId: options.sessionId,
    sourceRoot,
  });
  await withSessionLock(candidate.devSessionId, async () => {
    let manifest = await readManifest(candidate.devSessionId);
    if (retainsBetaSlotLease(manifest)) {
      await assertBetaSlotLease({
        slotId: manifest.targetEnvironment.betaSlot.assignedSlotId,
        ownerSessionId: manifest.devSessionId,
        leaseNonce: manifest.targetEnvironment.betaSlot.leaseNonce,
      });
    }
    const canReconcileStaleBeta =
      manifest.state === "stale" &&
      manifest.services.beta?.ownership === "dedicated";
    if (manifest.state === "ready" || canReconcileStaleBeta) {
      const inspection = await inspectSessionServices(manifest.services);
      if (inspection.stale) {
        const staleOwnedServices = Object.keys(inspection.services).filter(
          (serviceName) =>
            manifest.services[serviceName]?.ownership === "dedicated" &&
            inspection.services[serviceName]?.health === "stale",
        );
        manifest = updateManifest(manifest, {
          state: "stale",
          services: inspection.services,
          failure: {
            message: "owned service identity drifted",
            exitCode: 5,
            recovery: buildStaleRecovery(
              manifest.devSessionId,
              inspection.services,
              staleOwnedServices,
            ),
          },
        });
        await writeManifest(manifest);
      } else {
        manifest = updateManifest(manifest, {
          state: "ready",
          services: inspection.services,
          source: inspection.reconciled
            ? {
                ...manifest.source,
                revision: inspection.sourceRevision,
                dirty: inspection.sourceDirty ?? manifest.source.dirty,
              }
            : manifest.source,
          failure: null,
        });
        await writeManifest(manifest);
      }
    }
    printResult(publicManifest(manifest), options.json);
  });
}

async function runOpen(options, sourceRoot) {
  const manifest = await resolveManifestCandidate({
    sessionId: options.sessionId,
    sourceRoot,
  });
  if (manifest.state !== "ready") {
    throw new DevSessionError(
      `dev session is not ready: ${manifest.devSessionId} (${manifest.state})`,
      5,
    );
  }
  if (manifest.profile === "beta" && manifest.targetEnvironment.betaSlot) {
    await assertBetaSlotLease({
      slotId: manifest.targetEnvironment.betaSlot.assignedSlotId,
      ownerSessionId: manifest.devSessionId,
      leaseNonce: manifest.targetEnvironment.betaSlot.leaseNonce,
    });
  }
  const surface = assertSurface(
    options.surface ?? manifest.targetEnvironment.acceptanceSurfaces[0],
  );
  printResult(await resolveOpenTarget(manifest, surface), options.json);
}

async function runStop(options, sourceRoot) {
  const candidate = await resolveManifestCandidate({
    sessionId: options.sessionId,
    sourceRoot,
  });
  await withSessionLock(candidate.devSessionId, async () => {
    let manifest = await readManifest(candidate.devSessionId);
    const betaSlot = retainsBetaSlotLease(manifest)
      ? manifest.targetEnvironment.betaSlot
      : null;
    const finalizeBetaSlot = async () => {
      if (!betaSlot) {
        return null;
      }
      await assertBetaSlotLease({
        slotId: betaSlot.assignedSlotId,
        ownerSessionId: manifest.devSessionId,
        leaseNonce: betaSlot.leaseNonce,
      });
      const reset = await resetBetaSlotMutableState({
        slotId: betaSlot.assignedSlotId,
      });
      const retention = await applyBetaSlotRetention({
        slotId: betaSlot.assignedSlotId,
      });
      const cleanupSummary = { ...reset, retention };
      await recordBetaSlotRelease({
        slotId: betaSlot.assignedSlotId,
        revision: manifest.source.revision,
        cleanupSummary,
      });
      return cleanupSummary;
    };
    const retryServiceNames =
      options.cleanupStale && manifest.state === "stopped"
        ? Object.entries(manifest.services)
            .filter(
              ([, service]) =>
                service?.cleanupStatus === "skipped-stale-identity" &&
                processIdentityMatches(service.process),
            )
            .map(([serviceName]) => serviceName)
        : [];
    const retryingPartialCleanup = retryServiceNames.length > 0;
    if (manifest.state === "stopped" && !retryingPartialCleanup) {
      printResult(publicManifest(manifest), options.json);
      return;
    }
    if (
      !options.cleanupStale &&
      manifest.state === "failed" &&
      manifest.failure?.leaseRetained === false
    ) {
      manifest = updateManifest(manifest, {
        state: "stopped",
        failure: null,
      });
      await writeManifest(manifest);
      printResult(publicManifest(manifest), options.json);
      return;
    }
    if (options.cleanupStale) {
      if (manifest.state !== "stale" && !retryingPartialCleanup) {
        throw new DevSessionError(
          `--cleanup-stale requires a stale Session: ${manifest.devSessionId} (${manifest.state})`,
          5,
        );
      }
      manifest = updateManifest(manifest, { state: "stopping" });
      await writeManifest(manifest);
      try {
        const cleanup = await cleanupStaleSessionServices(
          manifest.services,
          retryingPartialCleanup ? { serviceNames: retryServiceNames } : {},
        );
        if (cleanup.summary.skippedStaleServices.length > 0) {
          manifest = updateManifest(manifest, { services: cleanup.services });
          throw new DevSessionError(
            "stale service identity drifted; refusing to reset or release Beta slot",
            5,
            {
              resetUnsafe: true,
              skippedStaleServices: cleanup.summary.skippedStaleServices,
            },
          );
        }
        const betaCleanup = await finalizeBetaSlot();
        manifest = updateManifest(manifest, {
          state: "stopped",
          services: cleanup.services,
          failure: null,
        });
        await writeManifest(manifest);
        if (betaSlot) {
          await releaseBetaSlotLease({
            slotId: betaSlot.assignedSlotId,
            ownerSessionId: manifest.devSessionId,
            leaseNonce: betaSlot.leaseNonce,
          });
        }
        printResult(
          {
            ...publicManifest(manifest),
            cleanup: { ...cleanup.summary, betaSlot: betaCleanup },
          },
          options.json,
        );
      } catch (error) {
        manifest = updateManifest(manifest, {
          state: "stale",
          failure: {
            message: error instanceof Error ? error.message : String(error),
            exitCode: error instanceof DevSessionError ? error.exitCode : 1,
          },
        });
        await writeManifest(manifest);
        throw error;
      }
      return;
    }
    if (manifest.state !== "failed" && manifest.state !== "planned") {
      try {
        await assertSessionServicesStoppable(manifest.services);
      } catch (error) {
        const details =
          error instanceof DevSessionError && error.details
            ? error.details
            : {};
        const staleOwnedServices = Array.isArray(details.staleOwnedServices)
          ? details.staleOwnedServices
          : [];
        const recovery = buildStaleRecovery(
          manifest.devSessionId,
          details.services ?? manifest.services,
          staleOwnedServices,
        );
        const enrichedError =
          error instanceof DevSessionError
            ? new DevSessionError(error.message, error.exitCode, {
                ...details,
                recovery,
              })
            : error;
        manifest = updateManifest(manifest, {
          state: "stale",
          failure: {
            message: error instanceof Error ? error.message : String(error),
            exitCode: error instanceof DevSessionError ? error.exitCode : 1,
            recovery,
          },
        });
        await writeManifest(manifest);
        throw enrichedError;
      }
    }
    manifest = updateManifest(manifest, { state: "stopping" });
    await writeManifest(manifest);
    try {
      await stopSessionServices(manifest.services, { identityVerified: true });
      await finalizeBetaSlot();
    } catch (error) {
      manifest = updateManifest(manifest, {
        state: "stale",
        failure: {
          message: error instanceof Error ? error.message : String(error),
          exitCode: error instanceof DevSessionError ? error.exitCode : 1,
        },
      });
      await writeManifest(manifest);
      throw error;
    }
    manifest = updateManifest(manifest, { state: "stopped", failure: null });
    await writeManifest(manifest);
    if (betaSlot) {
      await releaseBetaSlotLease({
        slotId: betaSlot.assignedSlotId,
        ownerSessionId: manifest.devSessionId,
        leaseNonce: betaSlot.leaseNonce,
      });
    }
    printResult(publicManifest(manifest), options.json);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(process.cwd());
  if (options.command === "start") {
    await runStart(options, sourceRoot);
  } else if (options.command === "status") {
    await runStatus(options, sourceRoot);
  } else if (options.command === "open") {
    await runOpen(options, sourceRoot);
  } else {
    await runStop(options, sourceRoot);
  }
}

main().catch((error) => {
  const exitCode = error instanceof DevSessionError ? error.exitCode : 1;
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    exitCode,
    ...(error instanceof DevSessionError && error.details
      ? { details: error.details }
      : {}),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
});
