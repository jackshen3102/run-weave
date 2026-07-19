import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateManifest } from "./contracts.mjs";
import { inspectSessionServices } from "./services.mjs";
import {
  processIdentityMatches,
  readProcessSignature,
} from "./service-runtime.mjs";
import {
  BETA_SLOT_CAPACITY,
  BETA_SLOT_IDS,
  BETA_SLOT_POLICY,
  inspectBetaPoolRootSafety,
  isPidLive,
  readRegularJson,
  resolveBetaPoolPaths,
  validateBetaSlotLease,
} from "./beta-slot-pool-core.mjs";
import { inspectBetaSlotProcessSafety } from "./beta-slot-pool-process-inspection.mjs";
import { readBetaSlotMetadata } from "./beta-slot-pool-storage.mjs";

async function readLease(slotId, paths) {
  try {
    const { value, stats } = await readRegularJson(
      path.join(paths.leasesDir, `${slotId}.lock`),
      paths.poolRoot,
    );
    return {
      state: "valid",
      value: validateBetaSlotLease(value, slotId),
      stats,
      failureReason: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        state: "absent",
        value: null,
        stats: null,
        failureReason: null,
      };
    }
    const stats = await fs
      .lstat(path.join(paths.leasesDir, `${slotId}.lock`))
      .catch(() => null);
    return {
      state: "corrupt",
      value: null,
      stats: stats && stats.isFile() && !stats.isSymbolicLink() ? stats : null,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readManifestObservation(lease) {
  if (!lease) {
    return {
      readState: "absent",
      value: null,
      failureReason: null,
    };
  }
  let handle;
  try {
    handle = await fs.open(
      lease.ownerManifestPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error("manifest is not a regular file");
    }
    const value = validateManifest(JSON.parse(await handle.readFile("utf8")));
    const named = await fs.lstat(lease.ownerManifestPath);
    if (
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      throw new Error("manifest identity changed while reading");
    }
    const betaSlot = value.targetEnvironment?.betaSlot;
    if (
      value.devSessionId !== lease.ownerSessionId ||
      value.source?.root !== lease.ownerSourceRoot ||
      betaSlot?.assignedSlotId !== lease.slotId ||
      betaSlot?.leaseNonce !== lease.leaseNonce
    ) {
      return {
        readState: "owner_mismatch",
        value,
        failureReason: "lease and manifest owner identity do not match",
      };
    }
    return { readState: "valid", value, failureReason: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        readState: "absent",
        value: null,
        failureReason: null,
      };
    }
    return {
      readState: "corrupt",
      value: null,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close();
  }
}

function serviceFacts(services, ownership) {
  return Object.fromEntries(
    Object.entries(services ?? {})
      .filter(
        ([name, service]) => name !== "cdp" && service?.ownership === ownership,
      )
      .map(([name, service]) => [
        name,
        {
          ownership,
          health: service.health ?? "unknown",
          reason: service.healthFailureReason ?? null,
          pid: service.process?.pid ?? service.pid ?? null,
        },
      ]),
  );
}

function aggregateHealth(components) {
  const values = Object.values(components);
  if (values.length === 0) {
    return "absent";
  }
  if (values.every((component) => component.health === "live")) {
    return "healthy";
  }
  if (values.some((component) => component.health === "unknown")) {
    return "unknown";
  }
  return values.some((component) => component.health === "live")
    ? "partial"
    : "absent";
}

async function inspectRuntime(manifestObservation) {
  if (manifestObservation.readState !== "valid") {
    return {
      ownedComponents: {},
      sharedDependencies: {},
      ownedHealth: "unknown",
      sharedHealth: "unknown",
      failureReason: manifestObservation.failureReason,
    };
  }
  try {
    const inspection = await inspectSessionServices(
      manifestObservation.value.services,
    );
    const ownedComponents = serviceFacts(inspection.services, "dedicated");
    const sharedDependencies = serviceFacts(
      inspection.services,
      "shared-declared",
    );
    return {
      ownedComponents,
      sharedDependencies,
      ownedHealth: aggregateHealth(ownedComponents),
      sharedHealth: aggregateHealth(sharedDependencies),
      failureReason: null,
    };
  } catch (error) {
    return {
      ownedComponents: {},
      sharedDependencies: {},
      ownedHealth: "unknown",
      sharedHealth: "unknown",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function liveIdentityDiagnostics(manifest, runtime) {
  const diagnostics = [];
  for (const [name, component] of Object.entries(runtime.ownedComponents)) {
    const service = manifest?.services?.[name];
    if (
      component.health !== "live" &&
      isPidLive(service?.process?.pid) &&
      !processIdentityMatches(service.process)
    ) {
      diagnostics.push({
        blocker: `owned-${name}-identity-mismatch`,
        code: "beta_pool_live_process_identity_mismatch",
        expected: {
          service: name,
          pid: service.process.pid,
          processSignature: service.process.processSignature,
        },
        actual: {
          service: name,
          pid: service.process.pid,
          processSignature: readProcessSignature(service.process.pid),
        },
      });
    }
  }
  return diagnostics;
}

function deriveSlot({ lease, manifest, runtime, processSafety }) {
  const checks = {
    leaseReadable: lease.state === "valid",
    manifestReadable: manifest.readState === "valid",
    ownerIdentityMatches: manifest.readState === "valid",
    allocatorProcessLive:
      lease.state === "valid" ? isPidLive(lease.value.allocatorPid) : null,
    processReferencesTrusted: processSafety.references.trusted,
    slotProcessesAbsent: processSafety.safeToReset,
    ownedRuntimeHealth: runtime.ownedHealth,
    sharedDependencyHealth: runtime.sharedHealth,
  };
  if (lease.state === "absent") {
    return {
      derivedState: "idle",
      reasons: [],
      recovery: {
        eligible: false,
        mode: "none",
        requiresCapacityPressure: false,
        checks,
        blockedBy: [],
        suggestedAction: "normal-allocation",
      },
    };
  }
  if (lease.state === "corrupt") {
    const blockedBy = [
      ...processSafety.unknown,
      ...processSafety.active.map((name) => `active-${name}`),
    ];
    return {
      derivedState: "broken",
      reasons: ["lease-corrupt"],
      recovery: {
        eligible: processSafety.safeToReset && Boolean(lease.stats),
        mode: processSafety.safeToReset ? "hygiene" : "manual",
        requiresCapacityPressure: false,
        checks,
        blockedBy,
        suggestedAction: processSafety.safeToReset
          ? "guarded-quarantine"
          : "inspect-process-references",
      },
    };
  }

  const acquisitionLive = isPidLive(lease.value.allocatorPid);
  if (manifest.readState === "absent") {
    const recent =
      Date.now() - Date.parse(lease.value.acquiredAt) <= 10 * 60_000;
    const blockedBy = [
      ...(acquisitionLive || recent ? ["acquisition-may-be-in-progress"] : []),
      ...processSafety.unknown,
      ...processSafety.active.map((name) => `active-${name}`),
    ];
    const eligible = !acquisitionLive && !recent && processSafety.safeToReset;
    return {
      derivedState: eligible ? "stale-reclaimable" : "stale-manual",
      reasons: ["manifest-absent"],
      recovery: {
        eligible,
        mode: eligible ? "hygiene" : "manual",
        requiresCapacityPressure: false,
        checks,
        blockedBy,
        suggestedAction: eligible
          ? "automatic-on-startup-hygiene"
          : "wait-or-inspect-orphan",
      },
    };
  }
  if (manifest.readState !== "valid") {
    const betaSlot = manifest.value?.targetEnvironment?.betaSlot;
    return {
      derivedState: "stale-manual",
      reasons: [`manifest-${manifest.readState}`],
      recovery: {
        eligible: false,
        mode: "manual",
        requiresCapacityPressure: false,
        checks,
        blockedBy: [manifest.failureReason ?? "manifest-unreadable"],
        code: "beta_pool_lease_manifest_mismatch",
        expected: {
          ownerSessionId: lease.value.ownerSessionId,
          ownerSourceRoot: lease.value.ownerSourceRoot,
          slotId: lease.value.slotId,
          leaseNonce: lease.value.leaseNonce,
        },
        actual: {
          ownerSessionId: manifest.value?.devSessionId ?? null,
          ownerSourceRoot: manifest.value?.source?.root ?? null,
          slotId: betaSlot?.assignedSlotId ?? null,
          leaseNonce: betaSlot?.leaseNonce ?? null,
        },
        suggestedAction: "repair-owner-identity",
      },
    };
  }

  const identityDiagnostics = liveIdentityDiagnostics(manifest.value, runtime);
  const identityBlockers = identityDiagnostics.map(
    (diagnostic) => diagnostic.blocker,
  );
  const recoveryDiagnostic = identityDiagnostics[0] ??
    (processSafety.unknown.length > 0
      ? {
          code: "beta_pool_process_reference_unknown",
          expected: {
            processReferencesTrusted: true,
            unknown: [],
          },
          actual: {
            processReferencesTrusted: processSafety.references.trusted,
            unknown: processSafety.unknown,
          },
        }
      : {
          code: "beta_pool_owned_runtime_unknown",
          expected: { ownedRuntimeHealth: "known" },
          actual: {
            ownedRuntimeHealth: runtime.ownedHealth,
            failureReason: runtime.failureReason,
          },
        });
  if (
    identityBlockers.length > 0 ||
    processSafety.unknown.length > 0 ||
    runtime.ownedHealth === "unknown"
  ) {
    return {
      derivedState: "stale-manual",
      reasons: identityBlockers.length
        ? identityBlockers
        : [
            runtime.ownedHealth === "unknown"
              ? "owned-runtime-unknown"
              : "process-references-unknown",
          ],
      recovery: {
        eligible: false,
        mode: "manual",
        requiresCapacityPressure: false,
        checks,
        blockedBy: [
          ...identityBlockers,
          ...processSafety.unknown,
          ...(runtime.ownedHealth === "unknown"
            ? [runtime.failureReason ?? "owned-runtime-unknown"]
            : []),
        ],
        code: recoveryDiagnostic.code,
        expected: recoveryDiagnostic.expected,
        actual: recoveryDiagnostic.actual,
        suggestedAction: "inspect-runtime-identity",
      },
    };
  }

  if (processSafety.safeToReset || manifest.value.state === "stopped") {
    return {
      derivedState: "stale-reclaimable",
      reasons: ["owned-runtime-absent"],
      recovery: {
        eligible: true,
        mode: "hygiene",
        requiresCapacityPressure: false,
        checks,
        blockedBy: [],
        suggestedAction: "automatic-on-startup-hygiene",
      },
    };
  }
  if (runtime.ownedHealth === "healthy") {
    const sharedDegraded = !["healthy", "absent"].includes(
      runtime.sharedHealth,
    );
    return {
      derivedState: sharedDegraded ? "degraded-shared" : "healthy",
      reasons: sharedDegraded ? ["shared-dependency-degraded"] : [],
      recovery: {
        eligible: false,
        mode: "none",
        requiresCapacityPressure: false,
        checks,
        blockedBy: sharedDegraded ? ["shared-dependency-degraded"] : [],
        suggestedAction: sharedDegraded
          ? "repair-shared-dependency"
          : "preserve",
      },
    };
  }
  return {
    derivedState: "partial",
    reasons: Object.entries(runtime.ownedComponents)
      .filter(([, component]) => component.health !== "live")
      .map(([name]) => `owned-${name}-unhealthy`),
    recovery: {
      eligible: true,
      mode: "capacity_pressure",
      requiresCapacityPressure: true,
      checks,
      blockedBy: [],
      suggestedAction: "automatic-on-capacity-pressure",
    },
  };
}

async function inspectPoolSlot(slotId, paths, homeDir) {
  const leaseObservation = await readLease(slotId, paths);
  const manifestObservation = await readManifestObservation(
    leaseObservation.value,
  );
  const [runtime, processSafety, metadataResult] = await Promise.all([
    inspectRuntime(manifestObservation),
    inspectBetaSlotProcessSafety(slotId, homeDir),
    readBetaSlotMetadata(slotId, { homeDir })
      .then((value) => ({ value, failureReason: null }))
      .catch((error) => ({
        value: null,
        failureReason: error instanceof Error ? error.message : String(error),
      })),
  ]);
  const derived = deriveSlot({
    lease: leaseObservation,
    manifest: manifestObservation,
    runtime,
    processSafety,
  });
  const lease =
    leaseObservation.state === "valid"
      ? {
          state: "valid",
          owner: {
            sessionId: leaseObservation.value.ownerSessionId,
            leaseNonce: leaseObservation.value.leaseNonce,
            sourceRoot: leaseObservation.value.ownerSourceRoot,
            revision: leaseObservation.value.ownerRevision,
          },
          acquisition: {
            pid: leaseObservation.value.allocatorPid,
            processLive: isPidLive(leaseObservation.value.allocatorPid),
            role: "short-lived-launcher",
            affectsRuntimeHealth: false,
          },
          acquiredAt: leaseObservation.value.acquiredAt,
          failureReason: null,
        }
      : {
          state: leaseObservation.state,
          owner: null,
          acquisition: null,
          acquiredAt: null,
          failureReason: leaseObservation.failureReason,
        };
  const manifest = {
    readState: manifestObservation.readState,
    state: manifestObservation.value?.state ?? null,
    sessionId: manifestObservation.value?.devSessionId ?? null,
    sourceRoot: manifestObservation.value?.source?.root ?? null,
    updatedAt: manifestObservation.value?.updatedAt ?? null,
    failureReason: manifestObservation.failureReason,
  };
  return {
    slotId,
    lease,
    manifest,
    runtime,
    derivedState: derived.derivedState,
    reasons: derived.reasons,
    recovery: derived.recovery,
    metadata: {
      lastReleasedAt: metadataResult.value?.lastReleasedAt ?? null,
      lastRecoveryAttempt: metadataResult.value?.lastRecoveryAttempt ?? null,
      failureReason: metadataResult.failureReason,
    },
  };
}

export async function inspectBetaPool({ homeDir = os.homedir() } = {}) {
  const paths = resolveBetaPoolPaths(homeDir);
  const rootFailure = await inspectBetaPoolRootSafety(paths);
  if (rootFailure) {
    throw new Error(rootFailure);
  }
  const slots = await Promise.all(
    BETA_SLOT_IDS.map((slotId) => inspectPoolSlot(slotId, paths, homeDir)),
  );
  const count = (state) =>
    slots.filter((slot) => slot.derivedState === state).length;
  return {
    schemaVersion: 1,
    policy: BETA_SLOT_POLICY,
    observedAt: new Date().toISOString(),
    reservationGuaranteed: false,
    capacity: BETA_SLOT_CAPACITY,
    summary: {
      idle: count("idle"),
      healthy: count("healthy"),
      partial: count("partial"),
      degradedShared: count("degraded-shared"),
      staleReclaimable: count("stale-reclaimable"),
      staleManual: count("stale-manual"),
      broken: count("broken"),
    },
    slots,
  };
}
