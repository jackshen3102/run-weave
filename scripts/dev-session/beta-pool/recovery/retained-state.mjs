import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DevSessionError, assertDevSessionId } from "../../contracts.mjs";
import { readManifest, withSessionLock } from "../../registry.mjs";
import {
  getPathIdentity,
  readReleaseId,
  resolveBetaPaths,
} from "../../../beta/state.mjs";
import { withBetaLock } from "../../../beta/operations.mjs";
import { resolveBetaAppBackupPrefix } from "../../../update/core.mjs";
import {
  acquireBetaSlotRecoveryClaim,
  assertBetaSlotId,
  atomicWriteJson,
  readRegularJson,
  releaseBetaSlotRecoveryClaim,
  resolveBetaPoolPaths,
  sameFileIdentity,
} from "../core.mjs";
import { assertBetaPoolStorageReadyForExistingLease } from "../storage/migration.mjs";
import { readBetaSlotMetadata } from "../metadata.mjs";
import { betaSlotProcessesAreAbsent } from "../process-inspection.mjs";
import {
  assertNoBetaSlotSymlinkComponents,
  validateBetaSlotRetentionState,
} from "../retention.mjs";

function refuse(message) {
  throw new DevSessionError(`retained-state repair refused: ${message}`, 5);
}

async function requireAbsent(filePath) {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  refuse("expected absent path exists");
}

// Explicit repair only. No allocator, status, janitor, or retention path calls it.
export async function repairBetaRetainedState({
  slotId,
  sessionId,
  expectedFailureAt,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
  env = process.env,
}) {
  assertBetaSlotId(slotId);
  assertDevSessionId(sessionId);
  if (!expectedFailureAt || !Number.isFinite(Date.parse(expectedFailureAt)))
    refuse("exact failure timestamp required");
  await assertBetaPoolStorageReadyForExistingLease({ homeDir });
  const pool = resolveBetaPoolPaths(homeDir);
  const claim = await acquireBetaSlotRecoveryClaim(slotId, pool);
  if (!claim) refuse("recovery claim busy");
  const sessionEnv = {
    ...env,
    RUNWEAVE_DEV_SESSION_HOME:
      env.RUNWEAVE_DEV_SESSION_HOME ??
      path.join(homeDir, ".runweave", "dev-sessions"),
  };
  try {
    return await withSessionLock(
      sessionId,
      async () => {
        const manifest = await readManifest(sessionId, sessionEnv);
        const slot = manifest.targetEnvironment?.betaSlot;
        const release = manifest.poolRecovery;
        if (
          manifest.devSessionId !== sessionId ||
          !["failed", "stopped"].includes(manifest.state) ||
          manifest.profile !== "beta" ||
          slot?.assignedSlotId !== slotId ||
          manifest.targetEnvironment.instanceId !== slotId ||
          release?.slotId !== slotId ||
          release.ownerSessionId !== sessionId ||
          release.leaseNonce !== slot.leaseNonce ||
          release.releasedLease !== true ||
          release.result !== "recovered" ||
          !Number.isFinite(Date.parse(manifest.createdAt)) ||
          !Number.isFinite(Date.parse(release.completedAt)) ||
          release.phase !== "completed" ||
          release.checks?.retentionFailed !==
            "Beta app previous pointer is invalid" ||
          !release.attemptId
        )
          refuse("released Session identity is not proven");
        const paths = resolveBetaPaths(
          manifest.source.root,
          homeDir,
          slotId,
          sessionId,
        );
        paths.appPath = path.join(
          applicationsDir,
          path.basename(paths.appPath),
        );
        await assertNoBetaSlotSymlinkComponents(homeDir, paths.statePath);
        await assertNoBetaSlotSymlinkComponents(applicationsDir, paths.appPath);
        return await withBetaLock(paths, async () => {
          const leasePath = path.join(pool.leasesDir, `${slotId}.lock`);
          const assertReleased = async () => {
            await requireAbsent(leasePath);
            if (!(await betaSlotProcessesAreAbsent(slotId, homeDir)))
              refuse("slot processes are not absent");
            const metadata = await readBetaSlotMetadata(slotId, { homeDir });
            const latest = metadata?.lastRecoveryAttempt;
            if (
              metadata?.lastRevision !== manifest.source.revision ||
              latest?.attemptId !== release.attemptId ||
              latest.ownerSessionId !== sessionId ||
              latest.leaseNonce !== release.leaseNonce ||
              latest.releasedLease !== true ||
              latest.result !== "recovered" ||
              latest.phase !== "completed" ||
              latest.completedAt !== release.completedAt
            )
              refuse("latest release record changed");
          };
          await assertReleased();
          await requireAbsent(paths.pendingPath);
          const observed = await readRegularJson(
            paths.statePath,
            paths.instanceRoot,
          );
          const state = observed.value;
          const previous = state.previous;
          const failure = state.lastFailure;
          if (
            failure?.at !== expectedFailureAt ||
            failure.component !== "beta-update" ||
            failure.attemptedGitHead !== manifest.source.revision ||
            Date.parse(failure.at) < Date.parse(manifest.createdAt) ||
            Date.parse(failure.at) > Date.parse(release.completedAt) ||
            state.sourceRoot !== manifest.source.root ||
            previous?.source?.sourceRoot !== manifest.source.root ||
            state.gitHead !== previous?.source?.gitHead ||
            state.appVersion !== previous?.app?.version ||
            state.runtimeReleaseId !== previous?.runtimeReleaseId ||
            state.appServerReleaseId !== previous?.appServerReleaseId ||
            previous?.app?.exists !== true
          ) {
            refuse(
              "failure/restored baseline evidence does not match this Session",
            );
          }
          await assertNoBetaSlotSymlinkComponents(
            homeDir,
            paths.runtimeCurrentPath,
          );
          await assertNoBetaSlotSymlinkComponents(
            homeDir,
            paths.appServerCurrentPath,
          );
          if (
            (await readReleaseId(paths.runtimeCurrentPath)) !==
              state.runtimeReleaseId ||
            (await readReleaseId(paths.appServerCurrentPath)) !==
              state.appServerReleaseId
          )
            refuse("runtime current pointers do not match restored state");
          const backup = previous.app.backupPath;
          const prefix = resolveBetaAppBackupPrefix(slotId, applicationsDir);
          if (
            typeof backup !== "string" ||
            path.resolve(backup) !== backup ||
            !(
              backup === prefix ||
              (backup.startsWith(`${prefix}-`) &&
                /^\d+$/.test(backup.slice(prefix.length + 1)))
            )
          ) {
            refuse("backup reference is outside the exact slot namespace");
          }
          await assertNoBetaSlotSymlinkComponents(applicationsDir, backup);
          await requireAbsent(backup);
          const appStats = await fs.lstat(paths.appPath);
          const identity = await getPathIdentity(paths.appPath);
          if (
            !appStats.isDirectory() ||
            appStats.isSymbolicLink() ||
            !previous.app.identity ||
            identity !== previous.app.identity
          ) {
            refuse("installed App is not the recorded restored inode");
          }
          if (
            typeof failure.logPath !== "string" ||
            path.dirname(failure.logPath) !== paths.logDir
          )
            refuse("restore log is outside the slot");
          await assertNoBetaSlotSymlinkComponents(
            paths.instanceRoot,
            failure.logPath,
          );
          const logStats = await fs.lstat(failure.logPath);
          if (
            !logStats.isFile() ||
            logStats.size > 64 * 1024 * 1024 ||
            !(await fs.readFile(failure.logPath, "utf8")).includes(
              "recovery=automatic-restore-applied",
            )
          )
            refuse("successful restore diagnostic is missing");
          const receipt = {
            schemaVersion: 1,
            attemptId: randomUUID(),
            trigger: "explicit_retained_state_repair",
            slotId,
            ownerSessionId: sessionId,
            sourceReleaseAttemptId: release.attemptId,
            expectedFailureAt,
            previousBackupPath: backup,
            installedAppIdentity: identity,
            repairedAt: new Date().toISOString(),
            result: "recovered",
          };
          const repaired = {
            ...state,
            previous: {
              ...previous,
              app: { ...previous.app, backupPath: null },
            },
            retainedStateRepair: receipt,
          };
          // No pruning/reset: all other state and all artifacts are preserved.
          const validate = (candidate) =>
            validateBetaSlotRetentionState({
              slotId,
              targets: paths,
              state: candidate,
              applicationsDir,
            });
          await validate(repaired);
          await assertReleased();
          await requireAbsent(paths.pendingPath);
          await requireAbsent(backup);
          if ((await getPathIdentity(paths.appPath)) !== identity)
            refuse("installed App changed before publication");
          const current = await readRegularJson(
            paths.statePath,
            paths.instanceRoot,
          );
          if (
            !sameFileIdentity(current.stats, observed.stats) ||
            JSON.stringify(current.value) !== JSON.stringify(state)
          )
            refuse("warm state changed before publication");
          await validate(repaired);
          await atomicWriteJson(paths.statePath, repaired, paths.instanceRoot);
          await validate(
            (await readRegularJson(paths.statePath, paths.instanceRoot)).value,
          );
          return receipt;
        });
      },
      sessionEnv,
    );
  } finally {
    await releaseBetaSlotRecoveryClaim(claim, pool);
  }
}
