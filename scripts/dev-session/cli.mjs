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
  applyAgentTeamFixtureBackendIsolation,
  inspectSessionServices,
  resolveOpenTarget,
  resolveSourceRevision,
  startSessionServices,
} from "./services.mjs";
import {
  BETA_SLOT_CAPACITY,
  acquireBetaSlotLease,
  applyBetaSlotRetention,
  assertBetaPoolDiskBudget,
  assertBetaSlotLease,
  inspectBetaSlotCapacity,
  runBetaPoolRecoveryPass,
  runBetaPoolJanitor,
} from "./beta-slot-pool.mjs";
import { runStop } from "./cli-stop.mjs";
import { resolveAgentTeamFixtureScope } from "./agent-team-fixture-scope.mjs";
import {
  readOptionalManifest,
  retainsBetaSlotLease,
  updateManifest,
} from "./cli-manifest.mjs";
import { cleanupFailedStart } from "./cli-start-cleanup.mjs";

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
  fixtureScope,
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
      agentTeamRunId: fixtureScope?.ownerRunId ?? null,
      agentTeamDispatchId: fixtureScope?.ownerDispatchId ?? null,
      agentTeamCaseIds: fixtureScope?.ownerCaseIds ?? [],
      fixtureNamespace: fixtureScope?.fixtureNamespace ?? null,
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

async function runStart(options, sourceRoot) {
  const changedFiles = await collectChangedFiles(
    sourceRoot,
    options.changedFiles,
  );
  let plan = buildDevSessionPlan({
    sourceRoot,
    changedFiles,
    explicitProfile: options.profile,
    explicitSurface: options.surface,
    explicitInstance: options.instanceId,
    serviceOverrides: options.serviceOverrides,
  });
  if (options.dryRun) {
    const fixtureScope = await resolveAgentTeamFixtureScope({
      sourceRoot: plan.sourceRoot,
      sessionId: "dry-run",
    });
    plan = applyAgentTeamFixtureBackendIsolation(plan, fixtureScope);
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
  const fixtureScope = await resolveAgentTeamFixtureScope({
    sourceRoot: plan.sourceRoot,
    sessionId,
  });
  plan = applyAgentTeamFixtureBackendIsolation(plan, fixtureScope);
  const revision = await resolveSourceRevision(sourceRoot);
  const poolRecovery = {
    trigger: "startup",
    recovered: [],
    preserved: [],
    blocked: [],
    failed: [],
    candidateOrder: [],
    orderingReason: null,
  };
  const mergePoolRecovery = (result) => {
    for (const key of ["recovered", "preserved", "blocked", "failed"]) {
      poolRecovery[key].push(...(result?.[key] ?? []));
    }
    poolRecovery.candidateOrder.push(
      ...(result?.candidateOrder ?? []).map((candidate) => ({
        ...candidate,
        trigger: result.trigger,
      })),
    );
    if (result?.orderingReason) {
      poolRecovery.orderingReason = result.orderingReason;
    }
  };
  if (plan.profile === "beta") {
    const hygiene = await runBetaPoolJanitor({
      initiatingSessionId: sessionId,
    });
    mergePoolRecovery(hygiene.poolRecovery);
  }
  let manifestCreated = false;
  let slotLease = null;
  let diskSummary = null;
  let startedServices = null;
  try {
    await withSessionLock(sessionId, async (paths) => {
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
        fixtureScope,
      });
      await writeManifest(manifest);
      manifestCreated = true;
      if (plan.profile === "beta") {
        const requestedSlotId = plan.targetEnvironment.betaSlot.requestedSlotId;
        for (let attempt = 0; attempt <= BETA_SLOT_CAPACITY; attempt += 1) {
          try {
            slotLease = await acquireBetaSlotLease({
              requestedSlotId,
              ownerSessionId: sessionId,
              ownerSourceRoot: sourceRoot,
              ownerRevision: revision,
              ownerManifestPath: paths.manifestPath,
            });
            break;
          } catch (error) {
            if (
              error instanceof DevSessionError &&
              [
                "beta_pool_legacy_drain_required",
                "beta_pool_storage_migration_busy",
                "beta_pool_storage_migration_blocked",
                "beta_pool_storage_conflict",
              ].includes(error.details?.code)
            ) {
              throw error;
            }
            if (
              !(error instanceof DevSessionError) ||
              attempt === BETA_SLOT_CAPACITY
            ) {
              throw error;
            }
            const pressure = await runBetaPoolRecoveryPass({
              strategy: "capacity_pressure",
              requestedSlotId,
              initiatingSessionId: sessionId,
            });
            mergePoolRecovery(pressure);
            if (pressure.recovered.length === 0) {
              throw new DevSessionError(error.message, error.exitCode, {
                ...error.details,
                code: requestedSlotId
                  ? "beta_pool_requested_slot_occupied"
                  : "beta_pool_capacity_exhausted",
                poolRecovery,
              });
            }
          }
        }
        if (!slotLease) {
          throw new DevSessionError(
            "Beta pool capacity was won by a concurrent allocator",
            5,
            {
              code: "beta_pool_capacity_won_by_concurrent_allocator",
              poolRecovery,
            },
          );
        }
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
        fixtureScope,
      });
      manifest = updateManifest(manifest, {
        state: "ready",
        services: startedServices,
      });
      await writeManifest(manifest);
      printResult(
        {
          ...publicManifest(manifest),
          ...(plan.profile === "beta" ? { poolRecovery } : {}),
        },
        options.json,
      );
    });
  } catch (error) {
    await cleanupFailedStart({
      error,
      sessionId,
      manifestCreated,
      slotLease,
      diskSummary,
      startedServices,
    });
    throw error;
  }
}

async function runStatus(options, sourceRoot) {
  const candidate = await resolveManifestCandidate({
    sessionId: options.sessionId,
    sourceRoot,
  });
  await withSessionLock(candidate.devSessionId, async () => {
    let manifest = await readManifest(candidate.devSessionId);
    if (
      manifest.state === "stopping" &&
      manifest.poolRecovery?.phase === "release_pending" &&
      manifest.targetEnvironment?.betaSlot?.assignedSlotId
    ) {
      const capacity = await inspectBetaSlotCapacity();
      const slot = capacity.slots.find(
        (entry) =>
          entry.slotId === manifest.targetEnvironment.betaSlot.assignedSlotId,
      );
      if (slot?.state === "idle") {
        const startFailed = manifest.poolRecovery.trigger === "start_failure";
        manifest = updateManifest(manifest, {
          state: startFailed ? "failed" : "stopped",
          poolRecovery: {
            ...manifest.poolRecovery,
            completedAt: new Date().toISOString(),
            phase: "completed",
            releasedLease: true,
          },
          failure: startFailed
            ? {
                message: "Beta Session start failed after safe slot cleanup",
                exitCode: 1,
                leaseRetained: false,
              }
            : null,
        });
        await writeManifest(manifest);
      }
    }
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
    await runStop(options, sourceRoot, {
      buildStaleRecovery,
      printResult,
      retainsBetaSlotLease,
      updateManifest,
    });
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
