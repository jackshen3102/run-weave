import { DevSessionError, publicManifest } from "./contracts.mjs";
import {
  readManifest,
  resolveManifestCandidate,
  withSessionLock,
  writeManifest,
} from "./registry.mjs";
import {
  assertSessionServicesStoppable,
  cleanupStaleSessionServices,
  stopSessionServices,
} from "./services.mjs";
import { processIdentityMatches } from "./service-runtime.mjs";
import {
  applyBetaSlotRetention,
  assertBetaSlotLease,
  betaSlotProcessesAreAbsent,
  recordBetaSlotRelease,
  releaseBetaSlotLease,
  resetBetaSlotMutableState,
} from "./beta-slot-pool.mjs";
import {
  backfillOwnedAgentTeamFixturesForStoppedSession,
  cleanupOwnedAgentTeamFixtures,
  completeOwnedAgentTeamFixturesAfterBetaSlotReset,
} from "./agent-team-fixture-cleanup.mjs";

export async function runStop(options, sourceRoot, helpers) {
  const {
    buildStaleRecovery,
    printResult,
    retainsBetaSlotLease,
    updateManifest,
  } = helpers;
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
      if (!(await betaSlotProcessesAreAbsent(betaSlot.assignedSlotId))) {
        throw new DevSessionError(
          "Beta slot processes remain; refusing to reset or release the slot",
          5,
          { slotId: betaSlot.assignedSlotId, resetUnsafe: true },
        );
      }
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
    const ensureFixtureCleanup = async () => {
      if (
        manifest.fixtureCleanup?.status === "completed" ||
        manifest.fixtureCleanup?.status === "not_required_shared_backend"
      ) {
        return manifest.fixtureCleanup;
      }
      const fixtureCleanup = await cleanupOwnedAgentTeamFixtures(manifest);
      if (!fixtureCleanup) {
        return null;
      }
      manifest = updateManifest(manifest, { fixtureCleanup });
      await writeManifest(manifest);
      if (fixtureCleanup.status === "failed") {
        throw new DevSessionError(
          "owned Agent Team fixture cleanup did not complete; refusing to stop services",
          5,
          { fixtureCleanup },
        );
      }
      return fixtureCleanup;
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
      if (
        manifest.controlPlane?.agentTeamRunId &&
        manifest.controlPlane?.agentTeamDispatchId
      ) {
        const fixtureCleanup =
          backfillOwnedAgentTeamFixturesForStoppedSession(manifest);
        if (!manifest.fixtureCleanup && !fixtureCleanup) {
          throw new DevSessionError(
            "stopped Agent Team Session lacks an auditable fixture cleanup receipt",
            5,
            { devSessionId: manifest.devSessionId },
          );
        }
        if (fixtureCleanup) {
          manifest = updateManifest(manifest, { fixtureCleanup });
          await writeManifest(manifest);
        }
      }
      printResult(publicManifest(manifest), options.json);
      return;
    }
    if (
      !options.cleanupStale &&
      manifest.state === "failed" &&
      manifest.failure?.leaseRetained === false
    ) {
      await ensureFixtureCleanup();
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
        let cleanup = await cleanupStaleSessionServices(
          manifest.services,
          retryingPartialCleanup ? { serviceNames: retryServiceNames } : {},
        );
        if (
          betaSlot &&
          cleanup.summary.skippedStaleServices.length > 0 &&
          (await betaSlotProcessesAreAbsent(betaSlot.assignedSlotId))
        ) {
          const alreadyStopped = cleanup.summary.skippedStaleServices.map(
            (entry) => entry.service,
          );
          const services = structuredClone(cleanup.services);
          for (const serviceName of alreadyStopped) {
            services[serviceName].cleanupStatus =
              "already-stopped-no-slot-processes";
          }
          cleanup = {
            services,
            summary: {
              ...cleanup.summary,
              stoppedServices: [
                ...cleanup.summary.stoppedServices,
                ...alreadyStopped,
              ],
              skippedStaleServices: [],
            },
          };
        }
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
        const fixtureCleanup =
          manifest.fixtureCleanup ??
          completeOwnedAgentTeamFixturesAfterBetaSlotReset(manifest);
        manifest = updateManifest(manifest, {
          state: "stopped",
          services: cleanup.services,
          ...(fixtureCleanup ? { fixtureCleanup } : {}),
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
    await ensureFixtureCleanup();
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
