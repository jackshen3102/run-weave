import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  applyBetaSlotRetention,
  assertBetaPoolDiskBudget,
  resetBetaSlotMutableState,
} from "./beta-slot-pool.mjs";
import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";
import {
  cleanupLegacyBeta,
  inventoryLegacyBeta,
  purgeLegacyBeta,
  restoreLegacyBeta,
} from "../runweave-beta-legacy.mjs";
import { isExternalTmuxReference } from "../runweave-beta-process-state.mjs";

export async function verifyBetaSlotStorage(
  temporaryHome,
  { includeLegacy = true } = {},
) {
  const betaAppPath = "/Applications/Runweave Beta pool-01.app";
  assert.equal(
    isExternalTmuxReference(
      `123 /opt/homebrew/bin/tmux RUNWEAVE_APP_PATH=${betaAppPath}`,
      [betaAppPath],
    ),
    true,
  );
  assert.equal(
    isExternalTmuxReference(
      `123 ${betaAppPath}/Contents/Resources/tmux --socket owned`,
      [betaAppPath],
    ),
    false,
  );

  const diskBudgetHome = path.join(temporaryHome, "disk-budget-home");
  const diskBudgetApplications = path.join(
    temporaryHome,
    "disk-budget-applications",
  );
  const diskBudgetTargets = resolveBetaUpdateTargets(diskBudgetHome, "pool-05");
  const diskBudgetAppPath = path.join(
    diskBudgetApplications,
    path.basename(diskBudgetTargets.appPath),
  );
  const frameworkVersions = path.join(
    diskBudgetAppPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
  );
  await fs.mkdir(path.join(frameworkVersions, "A"), { recursive: true });
  await fs.writeFile(
    path.join(frameworkVersions, "A", "Electron Framework"),
    "framework",
  );
  await fs.symlink("A", path.join(frameworkVersions, "Current"));
  await fs.symlink(
    path.join("Versions", "Current", "Electron Framework"),
    path.join(
      diskBudgetAppPath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  );
  const diskBudget = await assertBetaPoolDiskBudget({
    sourceRoot: process.cwd(),
    slotId: "pool-05",
    homeDir: diskBudgetHome,
    applicationsDir: diskBudgetApplications,
    env: { RUNWEAVE_BETA_POOL_MIN_FREE_BYTES: "0" },
  });
  assert(diskBudget.plannedWriteBytes > 0);

  const symlinkedAppTargets = resolveBetaUpdateTargets(
    diskBudgetHome,
    "pool-04",
  );
  await fs.symlink(
    diskBudgetAppPath,
    path.join(
      diskBudgetApplications,
      path.basename(symlinkedAppTargets.appPath),
    ),
  );
  await assert.rejects(
    assertBetaPoolDiskBudget({
      sourceRoot: process.cwd(),
      slotId: "pool-04",
      homeDir: diskBudgetHome,
      applicationsDir: diskBudgetApplications,
      env: { RUNWEAVE_BETA_POOL_MIN_FREE_BYTES: "0" },
    }),
    /refusing to size a symlinked Beta path/,
  );

  await assert.rejects(
    assertBetaPoolDiskBudget({
      sourceRoot: process.cwd(),
      slotId: "pool-05",
      homeDir: temporaryHome,
      env: {
        RUNWEAVE_BETA_POOL_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER - 1),
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "insufficient disk space for Beta slot start",
      );
      assert.equal(
        error.details.diskSummary.configuredFloor,
        Number.MAX_SAFE_INTEGER - 1,
      );
      assert(error.details.diskSummary.plannedWriteBytes > 0);
      assert(error.details.diskSummary.requiredFreeBytes > 0);
      assert.equal(error.details.diskSummary.cleanedBytes, 0);
      return true;
    },
  );

  const retentionHome = path.join(temporaryHome, "retention-home");
  const applicationsDir = path.join(temporaryHome, "Applications");
  const targets = resolveBetaUpdateTargets(retentionHome, "pool-02");
  const desktopReleases = path.join(targets.runtimeHome, "releases");
  const appServerRuntime = path.join(targets.appServerHome, "runtime");
  const appServerReleases = path.join(appServerRuntime, "releases");
  await Promise.all([
    ...["desktop-1", "desktop-2", "desktop-3"].map((releaseId) =>
      fs.mkdir(path.join(desktopReleases, releaseId), { recursive: true }),
    ),
    ...["app-server-1", "app-server-2", "app-server-3"].map((releaseId) =>
      fs.mkdir(path.join(appServerReleases, releaseId), { recursive: true }),
    ),
    fs.mkdir(path.dirname(targets.statePath), { recursive: true }),
    fs.mkdir(path.join(targets.instanceRoot, "diagnostics", "logs"), {
      recursive: true,
    }),
    fs.mkdir(applicationsDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(targets.runtimeHome, "current.json"),
      `${JSON.stringify({ releaseId: "desktop-3" })}\n`,
    ),
    fs.writeFile(
      path.join(appServerRuntime, "current.json"),
      `${JSON.stringify({ releaseId: "app-server-3" })}\n`,
    ),
  ]);
  const referencedBackup = path.join(
    applicationsDir,
    ".Runweave Beta pool-02.app.previous-2",
  );
  const migratedBackup = path.join(
    applicationsDir,
    ".Runweave Beta pool-02.rollback-2",
  );
  await Promise.all([
    fs.mkdir(referencedBackup),
    fs.mkdir(
      path.join(applicationsDir, ".Runweave Beta pool-02.app.previous-1"),
    ),
    fs.writeFile(
      targets.statePath,
      `${JSON.stringify({
        previous: {
          app: { exists: true, backupPath: referencedBackup },
          runtimeReleaseId: "desktop-2",
          appServerReleaseId: "app-server-2",
        },
      })}\n`,
    ),
    ...Array.from({ length: 7 }, (_, index) =>
      fs.writeFile(
        path.join(
          targets.instanceRoot,
          "diagnostics",
          "logs",
          `update-${index}.log`,
        ),
        String(index),
      ),
    ),
  ]);
  const retention = await applyBetaSlotRetention({
    slotId: "pool-02",
    homeDir: retentionHome,
    applicationsDir,
  });
  assert.deepEqual((await fs.readdir(desktopReleases)).sort(), [
    "desktop-2",
    "desktop-3",
  ]);
  assert.deepEqual((await fs.readdir(appServerReleases)).sort(), [
    "app-server-2",
    "app-server-3",
  ]);
  assert.equal(retention.logs.count, 5);
  assert.equal(retention.appBackupMigrated, true);
  assert.equal(retention.launchServicesUnregistered, 0);
  assert.deepEqual(await fs.readdir(applicationsDir), [
    path.basename(migratedBackup),
  ]);
  assert.equal(
    JSON.parse(await fs.readFile(targets.statePath, "utf8")).previous.app
      .backupPath,
    migratedBackup,
  );

  const absentBackupHome = path.join(temporaryHome, "absent-backup-home");
  const absentBackupApplications = path.join(
    temporaryHome,
    "absent-backup-applications",
  );
  const absentBackupTargets = resolveBetaUpdateTargets(
    absentBackupHome,
    "pool-03",
  );
  await Promise.all([
    fs.mkdir(path.dirname(absentBackupTargets.statePath), { recursive: true }),
    fs.mkdir(absentBackupApplications, { recursive: true }),
  ]);
  await fs.writeFile(
    absentBackupTargets.statePath,
    `${JSON.stringify({
      previous: {
        app: {
          exists: false,
          backupPath: path.join(
            absentBackupApplications,
            ".Runweave Beta pool-03.app.previous-missing",
          ),
        },
      },
    })}\n`,
  );
  const absentBackupRetention = await applyBetaSlotRetention({
    slotId: "pool-03",
    homeDir: absentBackupHome,
    applicationsDir: absentBackupApplications,
  });
  assert.equal(absentBackupRetention.appBackupMigrated, false);
  assert.deepEqual(await fs.readdir(absentBackupApplications), []);

  await fs.mkdir(targets.userData, { recursive: true });
  await fs.writeFile(path.join(targets.userData, "owner-a-cookie"), "secret");
  await fs.writeFile(
    path.join(targets.appServerHome, "app-server-token"),
    "secret",
  );
  await fs.writeFile(path.join(targets.runtimeHome, "warm-marker"), "warm");
  await fs.writeFile(path.join(appServerRuntime, "warm-marker"), "warm");
  await resetBetaSlotMutableState({
    slotId: "pool-02",
    homeDir: retentionHome,
  });
  assert.deepEqual(await fs.readdir(targets.userData), []);
  assert.equal(
    await fs.readFile(path.join(targets.runtimeHome, "warm-marker"), "utf8"),
    "warm",
  );
  assert.deepEqual((await fs.readdir(targets.appServerHome)).sort(), [
    "runtime",
  ]);

  if (!includeLegacy) {
    return;
  }

  const legacyHome = path.join(temporaryHome, "legacy-home");
  const legacyApplications = path.join(temporaryHome, "legacy-applications");
  const legacyTargets = resolveBetaUpdateTargets(legacyHome, "legacy-a");
  const legacyAppPath = path.join(
    legacyApplications,
    `${legacyTargets.appName}.app`,
  );
  await Promise.all([
    fs.mkdir(path.join(legacyAppPath, "Contents"), { recursive: true }),
    fs.mkdir(legacyTargets.instanceRoot, { recursive: true }),
    fs.mkdir(legacyTargets.appServerHome, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(legacyAppPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${legacyTargets.bundleId}</string></dict></plist>\n`,
  );
  const inventory = await inventoryLegacyBeta({
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  assert.equal(inventory.mode, "read-only-inventory");
  assert.equal(inventory.instances.length, 1);
  assert.equal(inventory.instances[0].trusted, true);
  const cleanup = await cleanupLegacyBeta({
    instanceId: "legacy-a",
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  assert.equal(cleanup.state, "quarantined");
  assert.equal(await fs.lstat(legacyAppPath).catch(() => null), null);
  const restored = await restoreLegacyBeta({
    operationId: cleanup.operationId,
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  assert.equal(restored.state, "restored");
  assert((await fs.lstat(legacyAppPath)).isDirectory());
  const cleanupAgain = await cleanupLegacyBeta({
    instanceId: "legacy-a",
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  await assert.rejects(
    purgeLegacyBeta({
      operationId: cleanupAgain.operationId,
      confirm: "wrong-operation",
      homeDir: legacyHome,
      applicationsDir: legacyApplications,
    }),
    /requires --confirm/,
  );
  const purged = await purgeLegacyBeta({
    operationId: cleanupAgain.operationId,
    confirm: cleanupAgain.operationId,
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  assert.equal(purged.state, "purged");

  const partialTargets = resolveBetaUpdateTargets(legacyHome, "legacy-partial");
  await fs.mkdir(partialTargets.appServerHome, { recursive: true });
  const partialInventory = await inventoryLegacyBeta({
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  const partialInstance = partialInventory.instances.find(
    (instance) => instance.instanceId === "legacy-partial",
  );
  assert.equal(partialInstance?.resources[0].exists, false);
  assert.equal(partialInstance?.trusted, true);
  const partialCleanup = await cleanupLegacyBeta({
    instanceId: "legacy-partial",
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
  assert.equal(partialCleanup.state, "quarantined");
  assert.equal(partialCleanup.entries.length, 1);
  assert.equal(partialCleanup.launchServicesUnregistered, false);
  await purgeLegacyBeta({
    operationId: partialCleanup.operationId,
    confirm: partialCleanup.operationId,
    homeDir: legacyHome,
    applicationsDir: legacyApplications,
  });
}
