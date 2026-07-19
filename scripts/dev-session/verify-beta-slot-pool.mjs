import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  BETA_SLOT_CAPACITY,
  BETA_SLOT_IDS,
  acquireBetaSlotLease,
  assertBetaSlotLease,
  betaSlotProcessesAreAbsent,
  inspectBetaSlotCapacity,
  releaseBetaSlotLease,
  resetBetaSlotMutableState,
  resolveBetaPoolPaths,
  runBetaPoolJanitor,
} from "./beta-slot-pool.mjs";
import {
  BETA_UPDATE_BUILDER_CONFIG,
  resolveBetaUpdateTargets,
  validateUpdateTargetIsolation,
} from "../runweave-update-core.mjs";
import { resolveBetaPaths } from "../runweave-beta-state.mjs";
import {
  buildUpdateArgs,
  buildUpdateEnv,
} from "../runweave-beta-operations.mjs";
import { buildBetaStopArgs } from "./beta-service.mjs";
import { verifyBetaSlotStorage } from "./verify-beta-slot-storage.mjs";
import { verifyBetaSlotPoolProjection } from "./verify-beta-slot-pool-projection.mjs";
import { verifyBetaSlotPoolRecovery } from "./verify-beta-slot-pool-recovery.mjs";
import { validateManifest } from "./contracts.mjs";

const execFileAsync = promisify(execFile);

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
  const rejectedLegacyInstance = "dvs-new-legacy";
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/runweave-beta.mjs",
        "update",
        "--instance",
        rejectedLegacyInstance,
        "--dry-run",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: temporaryHome },
      },
    ),
    (error) =>
      error?.code === 1 &&
      /Beta dev-session instance must be one of pool-01/.test(error.stderr),
  );
  assert.equal(
    await fs
      .lstat(
        resolveBetaUpdateTargets(temporaryHome, rejectedLegacyInstance)
          .instanceRoot,
      )
      .catch(() => null),
    null,
  );

  const sharedStopLockPath = path.join(
    temporaryHome,
    ".runweave",
    "app-server",
    "app-server.lock.json",
  );
  const stopArgs = buildBetaStopArgs({
    sourceRoot: process.cwd(),
    instanceId: "pool-01",
    sessionId: "dvs-shared-binding",
    sharedAppServer: {
      lockPath: sharedStopLockPath,
    },
  });
  assert.equal(
    stopArgs[stopArgs.indexOf("--shared-app-server-lock-path") + 1],
    sharedStopLockPath,
  );
  assert.equal(
    buildBetaStopArgs({
      sourceRoot: process.cwd(),
      instanceId: "pool-01",
      sessionId: "dvs-dedicated-binding",
      sharedAppServer: null,
    }).includes("--shared-app-server-lock-path"),
    false,
  );
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
    const sharedArgs = buildUpdateArgs(betaPaths, []);
    assert.equal(
      sharedArgs[sharedArgs.indexOf("--app-server-home") + 1],
      betaPaths.appServerHome,
    );
    const updateArg = (flag) => sharedArgs[sharedArgs.indexOf(flag) + 1];
    validateUpdateTargetIsolation({
      appBackupPath: betaPaths.appBackupPath,
      appName: betaPaths.appName,
      appPath: updateArg("--app-path"),
      appServerHome: updateArg("--app-server-home"),
      channel: "beta",
      electronBuilderConfig: BETA_UPDATE_BUILDER_CONFIG,
      homeDir: temporaryHome,
      instanceId: betaPaths.instanceId,
      runtimeHome: updateArg("--runtime-home"),
      statePath: updateArg("--state-path"),
    });
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
  await verifyBetaSlotPoolProjection(temporaryHome);

  const absentProcessHome = path.join(temporaryHome, "absent-process-home");
  assert.equal(
    await betaSlotProcessesAreAbsent("pool-01", absentProcessHome),
    true,
  );
  const liveProcessTargets = resolveBetaUpdateTargets(
    absentProcessHome,
    "pool-01",
  );
  await fs.mkdir(liveProcessTargets.userData, { recursive: true });
  await fs.writeFile(
    path.join(liveProcessTargets.userData, "beta-desktop-status.json"),
    `${JSON.stringify({ app: { pid: process.pid } })}\n`,
  );
  assert.equal(
    await betaSlotProcessesAreAbsent("pool-01", absentProcessHome),
    false,
  );
  const liveSlotProcess = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", liveProcessTargets.appPath],
    { stdio: "ignore" },
  );
  try {
    await fs.writeFile(
      path.join(liveProcessTargets.userData, "beta-desktop-status.json"),
      `${JSON.stringify({ app: { pid: liveSlotProcess.pid } })}\n`,
    );
    assert.equal(
      await betaSlotProcessesAreAbsent("pool-01", absentProcessHome),
      false,
    );
  } finally {
    if (liveSlotProcess.exitCode === null) {
      liveSlotProcess.kill("SIGTERM");
      await once(liveSlotProcess, "exit");
    }
  }

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
    path.join(janitorPaths.leasesDir, "pool-02.lock"),
    `${JSON.stringify(oldLease("pool-02", "dvs-orphan-no-state"))}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(janitorPaths.leasesDir, "pool-04.lock"),
    `${JSON.stringify(oldLease("pool-04", "dvs-orphan-safe"))}\n`,
    { mode: 0o600 },
  );
  const unsafeTargets = resolveBetaUpdateTargets(janitorHome, "pool-05");
  const unsafeSlotProcess = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", unsafeTargets.appPath],
    { stdio: "ignore" },
  );
  await fs.mkdir(unsafeTargets.userData, { recursive: true });
  await fs.writeFile(
    path.join(unsafeTargets.userData, "beta-desktop-status.json"),
    `${JSON.stringify({ app: { pid: unsafeSlotProcess.pid } })}\n`,
  );
  await fs.writeFile(
    path.join(janitorPaths.leasesDir, "pool-05.lock"),
    `${JSON.stringify(oldLease("pool-05", "dvs-orphan-unsafe"))}\n`,
    { mode: 0o600 },
  );
  try {
    const janitor = await runBetaPoolJanitor({
      homeDir: janitorHome,
      applicationsDir: janitorApplications,
    });
    assert.deepEqual(janitor.recovered, [
      { slotId: "pool-02", ownerSessionId: "dvs-orphan-no-state" },
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
  } finally {
    if (unsafeSlotProcess.exitCode === null) {
      unsafeSlotProcess.kill("SIGTERM");
      await once(unsafeSlotProcess, "exit");
    }
  }

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

  await verifyBetaSlotPoolRecovery(temporaryHome, oldLease);
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

  await verifyBetaSlotStorage(temporaryHome);
}
