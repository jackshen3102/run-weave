import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createBackendEnv } from "../dev.mjs";
import { INSTALLED_APP_CONTROL_PATH_PREFIXES } from "./runweave-update-core.mjs";

import {
  DEV_SESSION_SCHEMA_VERSION,
  DevSessionError,
  assertDevSessionId,
  assertLoopbackUrl,
  assertPathInside,
} from "./dev-session/contracts.mjs";
import { buildDevSessionPlan } from "./dev-session/planner.mjs";
import { startSessionServices } from "./dev-session/services.mjs";
import {
  acquireServicePortLease,
  atomicWriteJson,
  listManifestsForSource,
  readManifest,
  resolveManifestCandidate,
  resolveSessionPaths,
  withSessionLock,
  writeManifest,
} from "./dev-session/registry.mjs";

const execFileAsync = promisify(execFile);

function expectDevSessionError(callback, exitCode) {
  assert.throws(callback, (error) => {
    assert(error instanceof DevSessionError);
    assert.equal(error.exitCode, exitCode);
    return true;
  });
}

function createManifest({ sourceRoot, sessionId }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: DEV_SESSION_SCHEMA_VERSION,
    devSessionId: sessionId,
    state: "ready",
    profile: "fullstack",
    selectedBy: "changed-paths",
    controlPlane: {
      appChannel: "stable",
      sourceRoot,
      originTerminalSessionId: null,
      agentTeamRunId: null,
    },
    targetEnvironment: { kind: "fullstack", acceptanceSurfaces: ["web"] },
    source: { root: sourceRoot, revision: "verify", dirty: true },
    services: {
      frontend: { ownership: "dedicated" },
      backend: { ownership: "dedicated" },
      appServer: { ownership: "shared-declared" },
      electron: { ownership: "disabled" },
      beta: { ownership: "disabled" },
      cdp: {
        desktop: { ownership: "disabled" },
        terminalBrowser: { ownership: "disabled" },
      },
    },
    impacts: [],
    createdAt: now,
    updatedAt: now,
    failure: null,
  };
}

function verifyPlanner(sourceRoot) {
  const frontend = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
  });
  assert.equal(frontend.profile, "frontend");
  assert.equal(frontend.selectedBy, "changed-paths");

  const requiredSharedBackend = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "frontend",
    serviceOverrides: [
      "backend=shared-declared",
      "appServer=dedicated",
    ],
  });
  assert.equal(
    requiredSharedBackend.services.backend.ownership,
    "shared-declared",
  );
  assert.equal(
    requiredSharedBackend.services.backend.selectedBy,
    "explicit-service",
  );

  const explicitFullstack = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "fullstack",
  });
  assert.equal(explicitFullstack.profile, "fullstack");
  assert.equal(explicitFullstack.selectedBy, "explicit-profile");

  const explicitElectron = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "electron",
    explicitSurface: "desktop",
  });
  assert.equal(explicitElectron.profile, "electron");
  assert.deepEqual(explicitElectron.targetEnvironment.acceptanceSurfaces, [
    "desktop",
  ]);
  assert.equal(explicitElectron.executable, true);
  assert.deepEqual(explicitElectron.unsupportedServices, []);
  assert.equal(
    explicitElectron.services.backend.ownership,
    "shared-declared",
  );
  assert.equal(
    explicitElectron.services.appServer.ownership,
    "shared-declared",
  );

  const explicitBeta = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "beta",
    serviceOverrides: [
      "backend=shared-declared",
      "appServer=shared-declared",
    ],
  });
  assert.equal(explicitBeta.services.backend.ownership, "shared-declared");
  assert.equal(explicitBeta.services.appServer.ownership, "shared-declared");
  const betaWithBackendImpact = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["backend/src/index.ts"],
    explicitProfile: "beta",
  });
  assert.equal(betaWithBackendImpact.services.backend.ownership, "dedicated");
  assert.equal(
    betaWithBackendImpact.services.appServer.ownership,
    "shared-declared",
  );
  const betaWithAppServerImpact = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["app-server/src/index.ts"],
    explicitProfile: "beta",
  });
  assert.equal(
    betaWithAppServerImpact.services.backend.ownership,
    "dedicated",
  );
  assert.equal(
    betaWithAppServerImpact.services.appServer.ownership,
    "dedicated",
  );

  for (const backendChangedFile of [
    "backend/src/index.ts",
    "packages/shared/src/runtime-monitor.ts",
  ]) {
    const combinedBackendElectronImpact = buildDevSessionPlan({
      sourceRoot,
      changedFiles: [backendChangedFile, "electron/src/main.ts"],
    });
    assert.equal(combinedBackendElectronImpact.profile, "electron");
    assert.equal(
      combinedBackendElectronImpact.services.backend.ownership,
      "dedicated",
      backendChangedFile,
    );
    assert.equal(
      combinedBackendElectronImpact.services.appServer.ownership,
      "shared-declared",
      backendChangedFile,
    );
  }

  const sharedContract = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["packages/shared/src/runtime-monitor.ts"],
  });
  assert.equal(sharedContract.profile, "fullstack");
  assert.equal(sharedContract.impacts.length, 1);

  const betaControlPaths = [
    ...INSTALLED_APP_CONTROL_PATH_PREFIXES.map((prefix) =>
      prefix.endsWith("/") ? `${prefix}verify` : prefix,
    ),
    "scripts/runweave-beta-state.mjs",
    "scripts/runweave-beta-operations.mjs",
    "scripts/runweave-update-operations.mjs",
    "scripts/install-app-server-runtime.mjs",
  ];
  for (const changedFile of betaControlPaths) {
    const betaControlChange = buildDevSessionPlan({
      sourceRoot,
      changedFiles: [changedFile],
    });
    assert.equal(betaControlChange.profile, "beta", changedFile);
    assert.equal(betaControlChange.impacts.length, 1, changedFile);
  }

  const combinedDesktopContract = buildDevSessionPlan({
    sourceRoot,
    changedFiles: [
      "packages/shared/src/app-server/types.ts",
      "electron/src/main.ts",
    ],
  });
  assert.equal(combinedDesktopContract.profile, "beta");
  assert.equal(combinedDesktopContract.executable, true);

  const maxBetaInstance = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["scripts/runweave-beta.mjs"],
    explicitProfile: "beta",
    explicitInstance: "a".repeat(32),
  });
  assert.equal(maxBetaInstance.targetEnvironment.instanceId.length, 32);
  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["scripts/runweave-beta.mjs"],
        explicitProfile: "beta",
        explicitInstance: "a".repeat(33),
      }),
    2,
  );

  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["frontend/src/App.tsx"],
        explicitProfile: "frontend",
        serviceOverrides: ["electron=dedicated"],
      }),
    4,
  );

  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["backend/src/index.ts"],
        explicitProfile: "fullstack",
        serviceOverrides: ["backend=shared-declared"],
      }),
    4,
  );
  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["frontend/src/App.tsx"],
        explicitProfile: "fullstack",
        serviceOverrides: ["appServer=disabled"],
      }),
    4,
  );

  let incompleteProfileError = null;
  try {
    buildDevSessionPlan({
      sourceRoot,
      changedFiles: ["app-server/src/index.ts"],
      explicitProfile: "frontend",
    });
  } catch (error) {
    incompleteProfileError = error;
  }
  assert(incompleteProfileError instanceof DevSessionError);
  assert.equal(incompleteProfileError.exitCode, 4);
  assert.deepEqual(incompleteProfileError.details.missingServices, [
    "appServer",
    "backend",
  ]);
  assert.deepEqual(incompleteProfileError.details.requiredOwnership, {
    backend: "dedicated",
    appServer: "dedicated",
  });
  assert.deepEqual(incompleteProfileError.details.requestedOwnership, {
    backend: "shared-declared",
    appServer: "shared-declared",
  });
}

async function verifyRegistry(sourceRoot, temporaryHome) {
  const env = {
    ...process.env,
    RUNWEAVE_DEV_SESSION_HOME: path.join(temporaryHome, "dev-sessions"),
  };
  const first = createManifest({ sourceRoot, sessionId: "dvs-a1" });
  const second = createManifest({ sourceRoot, sessionId: "dvs-a2" });
  first.services.backend = {
    ownership: "dedicated",
    serviceInstanceId: "backend:verify-owner",
    ownerDevSessionId: first.devSessionId,
    pid: process.pid,
    resourceNamespace: "profile:verify-owner",
    sourceRevision: "verify",
  };
  await writeManifest(first, env);
  await writeManifest(second, env);

  const firstPaths = resolveSessionPaths(first.devSessionId, env);
  const secondPaths = resolveSessionPaths(second.devSessionId, env);
  assert.notEqual(firstPaths.sessionDir, secondPaths.sessionDir);
  assert.equal((await stat(firstPaths.sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(firstPaths.manifestPath)).mode & 0o777, 0o600);
  const serialized = await readFile(firstPaths.manifestPath, "utf8");
  assert(!serialized.includes("RUNWEAVE_HOOK_TOKEN"));
  assert(!serialized.includes("Authorization"));

  const candidates = await listManifestsForSource(sourceRoot, env);
  assert.deepEqual(
    candidates.map((candidate) => candidate.devSessionId),
    ["dvs-a1", "dvs-a2"],
  );
  await assert.rejects(
    resolveManifestCandidate({ sourceRoot, env }),
    (error) => error instanceof DevSessionError && error.exitCode === 3,
  );

  const staleLockPaths = resolveSessionPaths("dvs-stale-lock", env);
  await writeManifest(
    createManifest({ sourceRoot, sessionId: "dvs-stale-lock" }),
    env,
  );
  await writeFile(
    staleLockPaths.lockPath,
    `${JSON.stringify({ pid: 99999999, acquiredAt: "stale" })}\n`,
    { mode: 0o600 },
  );
  let staleLockRecovered = false;
  await withSessionLock(
    "dvs-stale-lock",
    () => {
      staleLockRecovered = true;
    },
    env,
  );
  assert.equal(staleLockRecovered, true);

  let releaseParallelLeaseBarrier;
  const parallelLeaseBarrier = new Promise((resolve) => {
    releaseParallelLeaseBarrier = resolve;
  });
  let parallelLeaseEntrants = 0;
  const holdIndependentLease = async (port, sessionId) => {
    const lease = await acquireServicePortLease(
      env.RUNWEAVE_DEV_SESSION_HOME,
      port,
      sessionId,
    );
    assert(lease);
    parallelLeaseEntrants += 1;
    if (parallelLeaseEntrants === 2) {
      releaseParallelLeaseBarrier();
    }
    await parallelLeaseBarrier;
    await lease.release();
  };
  await Promise.all([
    holdIndependentLease(6200, "dvs-port-a"),
    holdIndependentLease(6201, "dvs-port-b"),
  ]);
  assert.equal(parallelLeaseEntrants, 2);

  const liveLease = await acquireServicePortLease(
    env.RUNWEAVE_DEV_SESSION_HOME,
    6202,
    "dvs-port-a",
  );
  assert(liveLease);
  const liveLeasePath = path.join(
    env.RUNWEAVE_DEV_SESSION_HOME,
    ".port-leases",
    "6202.lock",
  );
  const liveLeaseOwner = JSON.parse(await readFile(liveLeasePath, "utf8"));
  assert.equal(liveLeaseOwner.pid, process.pid);
  assert.equal(liveLeaseOwner.sessionId, "dvs-port-a");
  assert.equal(typeof liveLeaseOwner.acquiredAt, "string");
  assert.equal(
    await acquireServicePortLease(
      env.RUNWEAVE_DEV_SESSION_HOME,
      6202,
      "dvs-port-b",
    ),
    null,
  );
  await liveLease.release();

  const stalePort = 6203;
  const staleLeasePath = path.join(
    env.RUNWEAVE_DEV_SESSION_HOME,
    ".port-leases",
    `${stalePort}.lock`,
  );
  await writeFile(
    staleLeasePath,
    `${JSON.stringify({ pid: 99999999, sessionId: "dvs-stale-port" })}\n`,
    { mode: 0o600 },
  );
  const staleRecoveryAttempts = await Promise.all([
    acquireServicePortLease(
      env.RUNWEAVE_DEV_SESSION_HOME,
      stalePort,
      "dvs-port-a",
    ),
    acquireServicePortLease(
      env.RUNWEAVE_DEV_SESSION_HOME,
      stalePort,
      "dvs-port-b",
    ),
  ]);
  const recoveredLeases = staleRecoveryAttempts.filter(Boolean);
  assert.equal(recoveredLeases.length, 1);
  await recoveredLeases[0].release();

  const partialLeasePath = path.join(
    env.RUNWEAVE_DEV_SESSION_HOME,
    ".port-leases",
    "6204.lock",
  );
  await writeFile(partialLeasePath, "", { mode: 0o600 });
  await utimes(partialLeasePath, new Date(0), new Date(0));
  assert.equal(
    await acquireServicePortLease(
      env.RUNWEAVE_DEV_SESSION_HOME,
      6204,
      "dvs-port-b",
    ),
    null,
  );
  assert.equal((await stat(partialLeasePath)).isFile(), true);

  const conflictSessionId = "dvs-conflict";
  const conflictPaths = resolveSessionPaths(conflictSessionId, env);
  const conflictProfileDir = path.join(
    conflictPaths.sessionDir,
    "browser-profile",
  );
  await mkdir(conflictProfileDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(conflictProfileDir, "backend.lock.json"),
    `${JSON.stringify({
      backendId: "verify-owner",
      devSessionId: null,
      pid: process.pid,
      port: 6205,
      host: "127.0.0.1",
      cwd: sourceRoot,
      startedAt: new Date().toISOString(),
      runtimeReleaseId: null,
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    startSessionServices({
      plan: {
        profile: "fullstack",
        sourceRoot,
        services: {
          frontend: { ownership: "dedicated" },
          backend: { ownership: "dedicated" },
          appServer: { ownership: "disabled" },
          electron: { ownership: "disabled" },
        },
      },
      sessionId: conflictSessionId,
      revision: "verify",
      paths: conflictPaths,
    }),
    (error) => {
      assert(error instanceof DevSessionError);
      assert.equal(error.exitCode, 5);
      assert.equal(error.details.conflict.type, "backend-profile-lock");
      assert.equal(error.details.conflict.owner.devSessionId, first.devSessionId);
      assert.equal(error.details.conflict.owner.pid, process.pid);
      assert.equal(
        error.details.conflict.remediation.command,
        `pnpm dev:stop --session ${first.devSessionId}`,
      );
      return true;
    },
  );

  const externalDirectory = path.join(temporaryHome, "outside");
  const linkedSessionPath = path.join(env.RUNWEAVE_DEV_SESSION_HOME, "dvs-link");
  await mkdir(externalDirectory, { mode: 0o700 });
  await symlink(externalDirectory, linkedSessionPath, "dir");
  await assert.rejects(
    withSessionLock("dvs-link", () => {}, env),
    (error) => error instanceof DevSessionError && error.exitCode === 4,
  );
  await assert.rejects(
    stat(path.join(externalDirectory, "session.lock")),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(
    writeManifest(
      createManifest({ sourceRoot, sessionId: "dvs-link" }),
      env,
    ),
    (error) => error instanceof DevSessionError && error.exitCode === 4,
  );
  await assert.rejects(
    stat(path.join(externalDirectory, "manifest.json")),
    (error) => error?.code === "ENOENT",
  );

  const newer = createManifest({ sourceRoot, sessionId: "dvs-newer" });
  const newerPaths = resolveSessionPaths(newer.devSessionId, env);
  await atomicWriteJson(newerPaths.manifestPath, {
    ...newer,
    schemaVersion: DEV_SESSION_SCHEMA_VERSION + 1,
  });
  await assert.rejects(
    readManifest(newer.devSessionId, env),
    (error) => error instanceof DevSessionError && error.exitCode === 4,
  );

  const recoverySession = createManifest({
    sourceRoot,
    sessionId: "dvs-recovery-guide",
  });
  await writeManifest(recoverySession, env);
  const recoveryStatus = await execFileAsync(
    process.execPath,
    [
      "scripts/dev-session/cli.mjs",
      "status",
      "--session",
      recoverySession.devSessionId,
      "--json",
    ],
    { cwd: sourceRoot, env },
  );
  const staleRecoveryManifest = JSON.parse(recoveryStatus.stdout);
  assert.equal(staleRecoveryManifest.state, "stale");
  assert.equal(
    staleRecoveryManifest.failure.recovery.command,
    `pnpm dev:stop --session ${recoverySession.devSessionId} --cleanup-stale --json`,
  );
  assert.equal(
    staleRecoveryManifest.failure.recovery.staleServices.some(
      (service) => service.service === "backend",
    ),
    true,
  );
  const recoveryCleanup = await execFileAsync(
    process.execPath,
    [
      "scripts/dev-session/cli.mjs",
      "stop",
      "--session",
      recoverySession.devSessionId,
      "--cleanup-stale",
      "--json",
    ],
    { cwd: sourceRoot, env },
  );
  const cleanedRecoveryManifest = JSON.parse(recoveryCleanup.stdout);
  assert.equal(cleanedRecoveryManifest.state, "stopped");
  assert.equal(
    cleanedRecoveryManifest.cleanup.skippedStaleServices.some(
      (service) => service.service === "backend",
    ),
    true,
  );
  assert.deepEqual(cleanedRecoveryManifest.cleanup.sharedServicesPreserved, [
    "appServer",
  ]);
  assert.equal((await readManifest(first.devSessionId, env)).state, "ready");
  assert.equal((await readManifest(second.devSessionId, env)).state, "ready");

  const staleSession = {
    ...createManifest({ sourceRoot, sessionId: "dvs-stale-session" }),
    state: "stale",
  };
  await writeManifest(staleSession, env);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/dev-session/cli.mjs",
        "start",
        "--session",
        staleSession.devSessionId,
        "--profile",
        "beta",
        "--json",
      ],
      { cwd: sourceRoot, env },
    ),
    (error) => error?.code === 5,
  );
  assert.equal(
    (await readManifest(staleSession.devSessionId, env)).state,
    "stale",
  );

  const raceSession = createManifest({
    sourceRoot,
    sessionId: "dvs-status-stop-race",
  });
  await writeManifest(raceSession, env);
  let statusPromise;
  await withSessionLock(
    raceSession.devSessionId,
    async () => {
      statusPromise = execFileAsync(
        process.execPath,
        [
          "scripts/dev-session/cli.mjs",
          "status",
          "--session",
          raceSession.devSessionId,
          "--json",
        ],
        { cwd: sourceRoot, env },
      ).then(
        (result) => ({ result, error: null }),
        (error) => ({ result: null, error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeManifest({ ...raceSession, state: "stopped" }, env);
    },
    env,
  );
  assert.equal((await statusPromise).error?.code, 5);
  assert.equal(
    (await readManifest(raceSession.devSessionId, env)).state,
    "stopped",
  );
}

function verifySafety(temporaryHome) {
  assert.equal(assertDevSessionId("dvs-safe-1"), "dvs-safe-1");
  expectDevSessionError(() => assertDevSessionId("../escape"), 2);
  assert.equal(
    assertLoopbackUrl("http://127.0.0.1:5173"),
    "http://127.0.0.1:5173",
  );
  expectDevSessionError(() => assertLoopbackUrl("http://example.com"), 4);
  expectDevSessionError(
    () =>
      assertPathInside(temporaryHome, path.join(temporaryHome, "..", "escape")),
    4,
  );
}

function verifyLegacyBackendEnv() {
  const explicitAppServer = {
    RUNWEAVE_APP_SERVER_URL: "http://127.0.0.1:6199",
    RUNWEAVE_APP_SERVER_TOKEN: "verify-token",
    RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
  };
  const env = createBackendEnv({
    baseEnv: explicitAppServer,
    backendPort: 5009,
  });
  assert.equal(
    env.RUNWEAVE_APP_SERVER_URL,
    explicitAppServer.RUNWEAVE_APP_SERVER_URL,
  );
  assert.equal(
    env.RUNWEAVE_APP_SERVER_TOKEN,
    explicitAppServer.RUNWEAVE_APP_SERVER_TOKEN,
  );
  assert.equal(env.RUNWEAVE_APP_SERVER_DISCOVERY, "explicit");
}

async function verifyBackendProfileLockPublication(sourceRoot, temporaryHome) {
  const profileDir = path.join(temporaryHome, "backend-profile-lock");
  const verificationSource = `
    import { mkdir, open, readFile, rm, utimes } from "node:fs/promises";
    import path from "node:path";
    import {
      acquireBackendProfileLock,
      BackendProfileLockConflictError,
    } from "./src/server/profile-lock.ts";

    void (async () => {
    const profileDir = process.env.RUNWEAVE_VERIFY_PROFILE_DIR;
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(profileDir, "backend.lock.json");
    const partialCreator = await open(lockFile, "wx", 0o600);
    await utimes(lockFile, new Date(0), new Date(0));
    let partialFailedClosed = false;
    try {
      await acquireBackendProfileLock({
        devSessionId: "dvs-profile-competitor",
        profileDir,
        port: 6206,
        host: "127.0.0.1",
      });
    } catch (error) {
      partialFailedClosed = error instanceof BackendProfileLockConflictError;
    }
    await partialCreator.close();
    await rm(lockFile);

    const lock = await acquireBackendProfileLock({
      devSessionId: "dvs-profile-owner",
      profileDir,
      port: 6206,
      host: "127.0.0.1",
    });
    const createdOwner = JSON.parse(await readFile(lockFile, "utf8"));
    await lock.update({ port: 6207 });
    const updatedOwner = JSON.parse(await readFile(lockFile, "utf8"));
    await lock.release();
    process.stdout.write(JSON.stringify({
      partialFailedClosed,
      createdDevSessionId: createdOwner.devSessionId,
      createdPort: createdOwner.port,
      updatedPort: updatedOwner.port,
      identityStable:
        createdOwner.backendId === updatedOwner.backendId &&
        createdOwner.pid === updatedOwner.pid,
    }) + "\\n");
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const { stdout } = await execFileAsync(
    "pnpm",
    ["-C", "backend", "exec", "tsx", "-e", verificationSource],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        RUNWEAVE_VERIFY_PROFILE_DIR: profileDir,
      },
    },
  );
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(result, {
    partialFailedClosed: true,
    createdDevSessionId: "dvs-profile-owner",
    createdPort: 6206,
    updatedPort: 6207,
    identityStable: true,
  });
}

async function main() {
  const temporaryHome = await mkdtemp(
    path.join(os.tmpdir(), "runweave-dev-session-"),
  );
  const sourceRoot = path.resolve(process.cwd());
  verifyPlanner(sourceRoot);
  await verifyRegistry(sourceRoot, temporaryHome);
  await verifyBackendProfileLockPublication(sourceRoot, temporaryHome);
  verifySafety(temporaryHome);
  verifyLegacyBackendEnv();
  process.stdout.write(
    `${JSON.stringify({ ok: true, checks: ["planner", "beta-control-chain-classification", "profile-adapters", "impact-driven-ownership", "ownership-boundary", "legacy-env-compatibility", "manifest-permissions", "candidate-resolution", "stale-lock-recovery", "parallel-port-leases", "atomic-port-lease-publication", "stale-port-lease-aba", "partial-port-lease-fail-closed", "backend-profile-conflict-attribution", "atomic-backend-profile-lock", "stale-session-recovery-guidance", "symlink-fail-closed", "status-stop-serialization", "stale-session-preservation", "newer-schema-fail-closed", "path-and-endpoint-safety"] })}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
