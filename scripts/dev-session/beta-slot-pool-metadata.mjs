import os from "node:os";
import path from "node:path";

import { DevSessionError } from "./contracts.mjs";
import {
  assertBetaSlotId,
  atomicWriteJson,
  readRegularJson,
  resolveBetaPoolPaths,
} from "./beta-slot-pool-core.mjs";

export async function recordBetaSlotRelease({
  slotId,
  revision,
  cleanupSummary,
  diskSummary = null,
  recoveryAttempt = undefined,
  homeDir = os.homedir(),
}) {
  const paths = resolveBetaPoolPaths(homeDir);
  const metadataPath = path.join(
    paths.metadataDir,
    `${assertBetaSlotId(slotId)}.json`,
  );
  const current = await readRegularJson(metadataPath, paths.poolRoot)
    .then(({ value }) => value)
    .catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
  await atomicWriteJson(
    metadataPath,
    {
      ...(current && typeof current === "object" ? current : {}),
      schemaVersion: 2,
      slotId,
      lastRevision: revision,
      lastReleasedAt: new Date().toISOString(),
      lastCleanupSummary: cleanupSummary,
      lastDiskSummary: diskSummary,
      lastRecoveryAttempt:
        recoveryAttempt === undefined
          ? (current?.lastRecoveryAttempt ?? null)
          : recoveryAttempt,
    },
    paths.poolRoot,
  );
}

export async function readBetaSlotMetadata(
  slotId,
  { homeDir = os.homedir() } = {},
) {
  const paths = resolveBetaPoolPaths(homeDir);
  try {
    const { value } = await readRegularJson(
      path.join(paths.metadataDir, `${assertBetaSlotId(slotId)}.json`),
      paths.poolRoot,
    );
    if (
      !value ||
      typeof value !== "object" ||
      ![1, 2].includes(value.schemaVersion) ||
      value.slotId !== slotId
    ) {
      throw new DevSessionError("Beta slot metadata is corrupt", 5, {
        slotId,
      });
    }
    return {
      ...value,
      lastRecoveryAttempt: value.lastRecoveryAttempt ?? null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function recordBetaSlotRecoveryAttempt({
  slotId,
  attempt,
  homeDir = os.homedir(),
}) {
  const current = await readBetaSlotMetadata(slotId, { homeDir });
  const paths = resolveBetaPoolPaths(homeDir);
  await atomicWriteJson(
    path.join(paths.metadataDir, `${assertBetaSlotId(slotId)}.json`),
    {
      ...(current ?? {}),
      schemaVersion: 2,
      slotId,
      lastRevision: current?.lastRevision ?? null,
      lastReleasedAt: current?.lastReleasedAt ?? null,
      lastCleanupSummary: current?.lastCleanupSummary ?? null,
      lastDiskSummary: current?.lastDiskSummary ?? null,
      lastRecoveryAttempt: attempt,
    },
    paths.poolRoot,
  );
}
