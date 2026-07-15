import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createBackendEnv } from "../../dev.mjs";
import {
  DEV_SESSION_SCHEMA_VERSION,
  DevSessionError,
  assertDevSessionId,
  assertLoopbackUrl,
  assertPathInside,
} from "./contracts.mjs";
import { startSessionServices } from "./services.mjs";
import { verifyStaleCleanupRetryConvergence } from "./verify-stale-cleanup-retry.mjs";
import {
  acquireServicePortLease,
  atomicWriteJson,
  listManifestsForSource,
  readManifest,
  resolveManifestCandidate,
  resolveSessionPaths,
  withSessionLock,
  writeManifest,
} from "./registry.mjs";

const execFileAsync = promisify(execFile);

export function expectDevSessionError(callback, exitCode) {
  assert.throws(callback, (error) => {
    assert(error instanceof DevSessionError);
    assert.equal(error.exitCode, exitCode);
    return true;
  });
}

export function createManifest({ sourceRoot, sessionId }) {
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

export async function verifyRegistry(sourceRoot, temporaryHome) {
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
      assert.equal(
        error.details.conflict.owner.devSessionId,
        first.devSessionId,
      );
      assert.equal(error.details.conflict.owner.pid, process.pid);
      assert.equal(
        error.details.conflict.remediation.command,
        `pnpm dev:stop --session ${first.devSessionId}`,
      );
      return true;
    },
  );

  const externalDirectory = path.join(temporaryHome, "outside");
  const linkedSessionPath = path.join(
    env.RUNWEAVE_DEV_SESSION_HOME,
    "dvs-link",
  );
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
    writeManifest(createManifest({ sourceRoot, sessionId: "dvs-link" }), env),
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
  await assert.rejects(
    execFileAsync(
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
    ),
    (error) => error?.code === 5,
  );
  const blockedRecoveryManifest = await readManifest(
    recoverySession.devSessionId,
    env,
  );
  assert.equal(blockedRecoveryManifest.state, "stale");
  assert.equal(
    blockedRecoveryManifest.failure.message,
    "stale service identity drifted; refusing to reset or release Beta slot",
  );
  await verifyStaleCleanupRetryConvergence({
    createManifest,
    recoverySession,
    sourceRoot,
    env,
  });

  const releasedLeaseHome = path.join(temporaryHome, "released-lease-home");
  const releasedLeaseNonce = "released-lease-nonce";
  const releasedLeaseSession = {
    ...createManifest({
      sourceRoot,
      sessionId: "dvs-failed-released-lease",
    }),
    state: "failed",
    profile: "beta",
    targetEnvironment: {
      kind: "beta",
      acceptanceSurfaces: ["desktop", "terminal-browser"],
      instanceId: "pool-01",
      betaSlot: {
        policy: "fixed-pool-v1",
        capacity: 5,
        requestedSlotId: null,
        assignedSlotId: "pool-01",
        leaseNonce: releasedLeaseNonce,
      },
    },
    services: Object.fromEntries(
      Object.entries(recoverySession.services).map(([serviceName, service]) => [
        serviceName,
        serviceName === "cdp"
          ? {
              desktop: {
                ...service.desktop,
                slotId: "pool-01",
                leaseNonce: releasedLeaseNonce,
              },
              terminalBrowser: {
                ...service.terminalBrowser,
                slotId: "pool-01",
                leaseNonce: releasedLeaseNonce,
              },
            }
          : {
              ...service,
              slotId: "pool-01",
              leaseNonce: releasedLeaseNonce,
            },
      ]),
    ),
    failure: {
      message: "start failed after identity-safe cleanup",
      exitCode: 1,
      leaseRetained: false,
    },
  };
  await writeManifest(releasedLeaseSession, env);
  const releasedLeaseEnv = { ...env, HOME: releasedLeaseHome };
  const releasedLeaseStatus = await execFileAsync(
    process.execPath,
    [
      "scripts/dev-session/cli.mjs",
      "status",
      "--session",
      releasedLeaseSession.devSessionId,
      "--json",
    ],
    { cwd: sourceRoot, env: releasedLeaseEnv },
  );
  assert.equal(JSON.parse(releasedLeaseStatus.stdout).state, "failed");
  const releasedLeaseStop = await execFileAsync(
    process.execPath,
    [
      "scripts/dev-session/cli.mjs",
      "stop",
      "--session",
      releasedLeaseSession.devSessionId,
      "--json",
    ],
    { cwd: sourceRoot, env: releasedLeaseEnv },
  );
  assert.equal(JSON.parse(releasedLeaseStop.stdout).state, "stopped");
  assert.equal(
    (await readManifest(releasedLeaseSession.devSessionId, env)).state,
    "stopped",
  );
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

export function verifySafety(temporaryHome) {
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

export function verifyLegacyBackendEnv() {
  const explicitAppServer = {
    RUNWEAVE_APP_SERVER_URL: "http://127.0.0.1:6199",
    RUNWEAVE_APP_SERVER_TOKEN: "verify-token",
    RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
  };
  const env = createBackendEnv({
    baseEnv: explicitAppServer,
    backendPort: 5009,
    sourceRoot: "/tmp/runweave-source-root",
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
  assert.equal(
    env.RUNWEAVE_TOOLKIT_PLUGIN_ROOT,
    path.join("/tmp/runweave-source-root", "electron", "resources"),
  );
}

export async function verifyBackendProfileLockPublication(
  sourceRoot,
  temporaryHome,
) {
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
