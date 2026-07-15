import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  BETA_SLOT_CAPACITY,
  BETA_SLOT_IDS,
  acquireBetaSlotLease,
  assertBetaPoolDiskBudget,
  assertBetaSlotLease,
  inspectBetaSlotCapacity,
  applyBetaSlotRetention,
  releaseBetaSlotLease,
  resetBetaSlotMutableState,
  resolveBetaPoolPaths,
  runBetaPoolJanitor,
} from "./beta-slot-pool.mjs";
import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";
import { resolveBetaPaths } from "../runweave-beta-state.mjs";
import {
  buildUpdateArgs,
  buildUpdateEnv,
} from "../runweave-beta-operations.mjs";
import { validateManifest } from "./contracts.mjs";
import {
  cleanupLegacyBeta,
  inventoryLegacyBeta,
  purgeLegacyBeta,
  restoreLegacyBeta,
} from "../runweave-beta-legacy.mjs";

function leaseOptions(homeDir, index, requestedSlotId = null) {
  return {
    homeDir,
    requestedSlotId,
    ownerSessionId: `dvs-pool-${index}`,
    ownerSourceRoot: path.join(homeDir, `source-${index}`),
    ownerRevision: `revision-${index}`,
    ownerManifestPath: path.join(homeDir, `manifest-${index}.json`),
  };
}

export async function verifyBetaSlotPool(temporaryHome) {
  const betaPaths = resolveBetaPaths(
    process.cwd(),
    temporaryHome,
    "pool-01",
    "dvs-shared-binding",
  );
  const ambientAppServer = Object.fromEntries(
    [
      "RUNWEAVE_APP_SERVER_DISCOVERY",
      "RUNWEAVE_APP_SERVER_HOME",
      "RUNWEAVE_APP_SERVER_TOKEN",
      "RUNWEAVE_APP_SERVER_URL",
      "RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH",
      "RUNWEAVE_SHARED_APP_SERVER_PID",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
    RUNWEAVE_APP_SERVER_HOME: "/tmp/ambient-app-server",
    RUNWEAVE_APP_SERVER_TOKEN: "ambient-token",
    RUNWEAVE_APP_SERVER_URL: "http://127.0.0.1:6198",
    RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH:
      "/tmp/ambient-app-server/app-server.lock.json",
    RUNWEAVE_SHARED_APP_SERVER_PID: "6198",
  });
  try {
    const isolatedEnv = buildUpdateEnv(betaPaths, "verify-revision");
    assert.equal(isolatedEnv.RUNWEAVE_APP_SERVER_HOME, betaPaths.appServerHome);
    assert.equal(isolatedEnv.RUNWEAVE_APP_SERVER_DISCOVERY, undefined);
    assert.equal(isolatedEnv.RUNWEAVE_APP_SERVER_TOKEN, undefined);
    assert.equal(isolatedEnv.RUNWEAVE_APP_SERVER_URL, undefined);
    assert.equal(isolatedEnv.RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH, undefined);
    assert.equal(isolatedEnv.RUNWEAVE_SHARED_APP_SERVER_PID, undefined);

    const sharedHome = path.join(temporaryHome, ".runweave", "app-server");
    const sharedAppServer = {
      homeDir: sharedHome,
      lockPath: path.join(sharedHome, "app-server.lock.json"),
      pid: 61_999,
      token: "explicit-token",
      url: "http://127.0.0.1:6199",
    };
    const sharedEnv = buildUpdateEnv(
      betaPaths,
      "verify-revision",
      betaPaths.appBackupPath,
      sharedAppServer,
    );
    assert.equal(sharedEnv.RUNWEAVE_APP_SERVER_HOME, sharedHome);
    assert.equal(
      sharedEnv.RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR,
      path.join(sharedHome, "cloud-sync"),
    );
    assert.equal(sharedEnv.RUNWEAVE_APP_SERVER_DISCOVERY, "explicit");
    assert.equal(sharedEnv.RUNWEAVE_APP_SERVER_TOKEN, "explicit-token");
    assert.equal(sharedEnv.RUNWEAVE_APP_SERVER_URL, sharedAppServer.url);
    assert.equal(
      sharedEnv.RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH,
      sharedAppServer.lockPath,
    );
    assert.equal(sharedEnv.RUNWEAVE_SHARED_APP_SERVER_PID, "61999");
    const sharedArgs = buildUpdateArgs(betaPaths, [], sharedHome);
    assert.equal(
      sharedArgs[sharedArgs.indexOf("--app-server-home") + 1],
      sharedHome,
    );
  } finally {
    for (const [key, value] of Object.entries(ambientAppServer)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  const legacyManifest = {
    schemaVersion: 1,
    devSessionId: "dvs-legacy-beta",
    state: "ready",
    profile: "beta",
    controlPlane: { appChannel: "stable" },
    targetEnvironment: {
      kind: "beta",
      acceptanceSurfaces: ["desktop"],
      instanceId: null,
    },
    source: { root: process.cwd(), revision: "legacy", dirty: false },
    services: {},
  };
  assert.equal(validateManifest(legacyManifest), legacyManifest);
  assert.throws(
    () =>
      validateManifest({
        ...legacyManifest,
        targetEnvironment: {
          ...legacyManifest.targetEnvironment,
          instanceId: "pool-01",
        },
      }),
    /missing betaSlot/,
  );
  const paths = resolveBetaPoolPaths(temporaryHome);
  const before = await fs.lstat(paths.poolRoot).catch(() => null);
  const emptySnapshot = await inspectBetaSlotCapacity({
    homeDir: temporaryHome,
  });
  const after = await fs.lstat(paths.poolRoot).catch(() => null);
  assert.equal(before, null);
  assert.equal(after, null);
  assert.equal(emptySnapshot.authoritative, false);
  assert.equal(emptySnapshot.capacity, BETA_SLOT_CAPACITY);
  assert.equal(emptySnapshot.idle, BETA_SLOT_CAPACITY);

  const attempts = await Promise.allSettled(
    Array.from({ length: BETA_SLOT_CAPACITY + 1 }, (_, index) =>
      acquireBetaSlotLease(leaseOptions(temporaryHome, index)),
    ),
  );
  const acquired = attempts
    .filter((attempt) => attempt.status === "fulfilled")
    .map((attempt) => attempt.value);
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(acquired.length, BETA_SLOT_CAPACITY);
  assert.equal(rejected.length, 1);
  assert.deepEqual(
    new Set(acquired.map((entry) => entry.lease.slotId)),
    new Set(BETA_SLOT_IDS),
  );

  await assert.rejects(
    acquireBetaSlotLease(leaseOptions(temporaryHome, 9, "pool-01")),
    /occupied or broken/,
  );

  const resetBarrierHome = path.join(temporaryHome, "reset-barrier-home");
  const resetBarrierTargets = resolveBetaUpdateTargets(
    resetBarrierHome,
    "pool-05",
  );
  const resetBarrierLease = await acquireBetaSlotLease(
    leaseOptions(resetBarrierHome, 20, "pool-05"),
  );
  await fs.mkdir(resetBarrierTargets.userData, { recursive: true });
  await fs.writeFile(
    path.join(resetBarrierTargets.userData, "owner-a-marker"),
    "owner-a",
  );
  let releaseResetBarrier;
  const resetBarrier = new Promise((resolve) => {
    releaseResetBarrier = resolve;
  });
  let signalUserDataSwapped;
  const userDataSwapped = new Promise((resolve) => {
    signalUserDataSwapped = resolve;
  });
  const resetPromise = resetBetaSlotMutableState({
    slotId: "pool-05",
    homeDir: resetBarrierHome,
    afterUserDataSwap: async () => {
      signalUserDataSwapped();
      await resetBarrier;
    },
  });
  await userDataSwapped;
  await assert.rejects(
    acquireBetaSlotLease(leaseOptions(resetBarrierHome, 21, "pool-05")),
    /occupied or broken/,
  );
  releaseResetBarrier();
  await resetPromise;
  await releaseBetaSlotLease(resetBarrierLease);
  const nextOwnerLease = await acquireBetaSlotLease(
    leaseOptions(resetBarrierHome, 22, "pool-05"),
  );
  await releaseBetaSlotLease(nextOwnerLease);

  const janitorHome = path.join(temporaryHome, "janitor-home");
  const janitorApplications = path.join(temporaryHome, "janitor-applications");
  const janitorPaths = resolveBetaPoolPaths(janitorHome);
  await Promise.all([
    fs.mkdir(janitorPaths.leasesDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(janitorApplications, { recursive: true }),
  ]);
  const oldLease = (slotId, ownerSessionId) => ({
    schemaVersion: 1,
    slotId,
    leaseNonce: `nonce-${slotId}`,
    ownerSessionId,
    ownerSourceRoot: process.cwd(),
    ownerRevision: "verify-revision",
    ownerManifestPath: path.join(janitorHome, `${ownerSessionId}.json`),
    allocatorPid: 99_999_999,
    acquiredAt: "2000-01-01T00:00:00.000Z",
  });
  const writeInactiveProcessEvidence = async (targets) => {
    await Promise.all([
      fs.mkdir(path.join(targets.userData, "browser-profile"), {
        recursive: true,
      }),
      fs.mkdir(targets.appServerHome, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(targets.userData, "beta-desktop-status.json"),
        `${JSON.stringify({ app: { pid: 99_999_991 } })}\n`,
      ),
      fs.writeFile(
        path.join(targets.userData, "browser-profile", "backend.lock.json"),
        `${JSON.stringify({ pid: 99_999_992 })}\n`,
      ),
      fs.writeFile(
        path.join(targets.appServerHome, "app-server.lock.json"),
        `${JSON.stringify({ pid: 99_999_993 })}\n`,
      ),
    ]);
  };
  const safeTargets = resolveBetaUpdateTargets(janitorHome, "pool-04");
  await writeInactiveProcessEvidence(safeTargets);
  await fs.writeFile(
    path.join(janitorPaths.leasesDir, "pool-04.lock"),
    `${JSON.stringify(oldLease("pool-04", "dvs-orphan-safe"))}\n`,
    { mode: 0o600 },
  );
  const unsafeTargets = resolveBetaUpdateTargets(janitorHome, "pool-05");
  await fs.mkdir(unsafeTargets.userData, { recursive: true });
  await fs.writeFile(
    path.join(unsafeTargets.userData, "beta-desktop-status.json"),
    `${JSON.stringify({ app: { pid: process.pid } })}\n`,
  );
  await fs.writeFile(
    path.join(janitorPaths.leasesDir, "pool-05.lock"),
    `${JSON.stringify(oldLease("pool-05", "dvs-orphan-unsafe"))}\n`,
    { mode: 0o600 },
  );
  const janitor = await runBetaPoolJanitor({
    homeDir: janitorHome,
    applicationsDir: janitorApplications,
  });
  assert.deepEqual(janitor.recovered, [
    { slotId: "pool-04", ownerSessionId: "dvs-orphan-safe" },
  ]);
  assert(
    janitor.broken.some(
      (entry) =>
        entry.slotId === "pool-05" &&
        entry.reason.includes("orphan identity is not safe"),
    ),
  );
  assert.equal(
    await fs
      .lstat(path.join(janitorPaths.leasesDir, "pool-04.lock"))
      .catch(() => null),
    null,
  );
  assert(
    (
      await fs.lstat(path.join(janitorPaths.leasesDir, "pool-05.lock"))
    ).isFile(),
  );

  const concurrentJanitorHome = path.join(
    temporaryHome,
    "concurrent-janitor-home",
  );
  const concurrentJanitorApplications = path.join(
    temporaryHome,
    "concurrent-janitor-applications",
  );
  const concurrentJanitorPaths = resolveBetaPoolPaths(concurrentJanitorHome);
  await Promise.all([
    fs.mkdir(concurrentJanitorPaths.leasesDir, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(concurrentJanitorApplications, { recursive: true }),
  ]);
  await writeInactiveProcessEvidence(
    resolveBetaUpdateTargets(concurrentJanitorHome, "pool-03"),
  );
  await fs.writeFile(
    path.join(concurrentJanitorPaths.leasesDir, "pool-03.lock"),
    `${JSON.stringify(oldLease("pool-03", "dvs-concurrent-orphan"))}\n`,
    { mode: 0o600 },
  );
  const concurrentJanitors = await Promise.all(
    Array.from({ length: 4 }, () =>
      runBetaPoolJanitor({
        homeDir: concurrentJanitorHome,
        applicationsDir: concurrentJanitorApplications,
      }),
    ),
  );
  assert.deepEqual(
    concurrentJanitors.flatMap((result) => result.recovered),
    [{ slotId: "pool-03", ownerSessionId: "dvs-concurrent-orphan" }],
  );
  assert.deepEqual(
    concurrentJanitors.flatMap((result) => result.broken),
    [],
  );
  assert.equal(
    await fs
      .lstat(path.join(concurrentJanitorPaths.leasesDir, "pool-03.lock"))
      .catch(() => null),
    null,
  );
  assert.deepEqual(
    await fs.readdir(concurrentJanitorPaths.recoveryClaimsDir),
    [],
  );
  const first = acquired.find((entry) => entry.lease.slotId === "pool-01");
  await assert.rejects(
    assertBetaSlotLease({
      homeDir: temporaryHome,
      slotId: first.lease.slotId,
      ownerSessionId: first.lease.ownerSessionId,
      leaseNonce: "wrong-nonce",
    }),
    /identity drifted/,
  );
  assert((await fs.lstat(first.leasePath)).isFile());

  await Promise.all(acquired.map((entry) => releaseBetaSlotLease(entry)));
  const releasedSnapshot = await inspectBetaSlotCapacity({
    homeDir: temporaryHome,
  });
  assert.equal(releasedSnapshot.idle, BETA_SLOT_CAPACITY);

  await fs.mkdir(paths.leasesDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(paths.leasesDir, "pool-01.lock"),
    `${JSON.stringify({ schemaVersion: 999, slotId: "pool-01" })}\n`,
    { mode: 0o600 },
  );
  const brokenSnapshot = await inspectBetaSlotCapacity({
    homeDir: temporaryHome,
  });
  assert.equal(
    brokenSnapshot.slots.find((slot) => slot.slotId === "pool-01").state,
    "broken",
  );
  const healthyLease = await acquireBetaSlotLease(
    leaseOptions(temporaryHome, 10),
  );
  assert.notEqual(healthyLease.lease.slotId, "pool-01");
  await releaseBetaSlotLease(healthyLease);
  await fs.writeFile(
    path.join(paths.leasesDir, "pool-02.lock"),
    "{broken-json",
    {
      mode: 0o600,
    },
  );
  const symlinkTarget = path.join(temporaryHome, "outside-lease.json");
  await fs.writeFile(symlinkTarget, "{}\n", { mode: 0o600 });
  await fs.symlink(symlinkTarget, path.join(paths.leasesDir, "pool-03.lock"));
  const unsafeSnapshot = await inspectBetaSlotCapacity({
    homeDir: temporaryHome,
  });
  assert.deepEqual(
    unsafeSnapshot.slots
      .filter((slot) => ["pool-01", "pool-02", "pool-03"].includes(slot.slotId))
      .map((slot) => slot.state),
    ["broken", "broken", "broken"],
  );
  const remainingHealthyLease = await acquireBetaSlotLease(
    leaseOptions(temporaryHome, 11),
  );
  assert(["pool-04", "pool-05"].includes(remainingHealthyLease.lease.slotId));
  await releaseBetaSlotLease(remainingHealthyLease);

  const diskBudgetHome = path.join(temporaryHome, "disk-budget-home");
  const diskBudgetApplications = path.join(
    temporaryHome,
    "disk-budget-applications",
  );
  const diskBudgetTargets = resolveBetaUpdateTargets(
    diskBudgetHome,
    "pool-05",
  );
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
  assert.deepEqual(await fs.readdir(applicationsDir), [
    path.basename(referencedBackup),
  ]);

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
}
