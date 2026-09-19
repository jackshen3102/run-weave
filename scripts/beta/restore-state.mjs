import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { readJson, writeJson } from "./state.mjs";
import { applyBetaSlotRetention } from "../dev-session/beta-pool/storage/index.mjs";
import { validateBetaSlotRetentionState } from "../dev-session/beta-pool/retention.mjs";

// Keep a single retained generation, not an ever-growing rollback history.
export function snapshotPreviousRelease(previous) {
  if (!previous?.app) return null;
  const { app, runtimeReleaseId, appServerReleaseId, source, capturedAt } =
    previous;
  return structuredClone({
    app,
    runtimeReleaseId,
    appServerReleaseId,
    source,
    capturedAt,
  });
}

export async function publishRestoredBaseline(
  paths,
  baseline,
  appBackupConsumed,
) {
  const state = (await readJson(paths.statePath)) ?? {};
  const previous =
    baseline.priorPrevious ??
    (appBackupConsumed ? null : snapshotPreviousRelease(baseline));
  const restored = {
    ...state,
    appServer: baseline.appServerReleaseId
      ? {
          ...(state.appServer ?? {}),
          home: paths.appServerHome,
          releaseId: baseline.appServerReleaseId,
        }
      : null,
    appServerAction: baseline.appServerReleaseId ? "restored" : null,
    appServerReleaseId: baseline.appServerReleaseId,
    appVersion: baseline.app.version,
    channel: "beta",
    gitDirty: baseline.source?.gitDirty ?? null,
    gitHead: baseline.source?.gitHead ?? null,
    previous,
    runtimeReleaseId: baseline.runtimeReleaseId,
    sourceRoot: baseline.source?.sourceRoot ?? paths.sourceRoot,
    updatedAt: baseline.source?.updatedAt ?? null,
    worktreeSnapshot: baseline.source?.worktreeSnapshot ?? null,
  };
  if (paths.slotId) {
    await validateBetaSlotRetentionState({
      slotId: paths.slotId,
      targets: paths,
      state: restored,
      applicationsDir: path.dirname(paths.appPath),
    });
  }
  await writeJson(paths.statePath, restored);
  // A consumed backup must never be resurrected by pending-state retention.
  await fs.rm(paths.pendingPath, { force: true });
  return restored;
}

export async function commitHealthyBetaUpdate(
  paths,
  state,
  baseline,
  logPath,
  { homeDir = os.homedir() } = {},
) {
  await writeJson(paths.statePath, {
    ...state,
    channel: "beta",
    previous: { ...baseline, priorPrevious: null, priorAppBackupPath: null },
    logPath,
    lastFailure: null,
  });
  await fs.rm(paths.pendingPath, { force: true });
  if (paths.slotId) {
    await applyBetaSlotRetention({
      slotId: paths.slotId,
      homeDir,
      applicationsDir: path.dirname(paths.appPath),
    });
  } else if (
    state.mode === "app" &&
    baseline.priorAppBackupPath &&
    baseline.priorAppBackupPath !== baseline.app.backupPath
  ) {
    await fs.rm(baseline.priorAppBackupPath, { force: true, recursive: true });
  }
  return await readJson(paths.statePath);
}
