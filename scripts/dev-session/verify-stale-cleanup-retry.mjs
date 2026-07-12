import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isProcessLive, spawnDetached } from "./service-runtime.mjs";
import { resolveSessionPaths, writeManifest } from "./registry.mjs";

const execFileAsync = promisify(execFile);

export async function verifyStaleCleanupRetryConvergence({
  createManifest,
  recoverySession,
  sourceRoot,
  env,
}) {
  const inertCleanupRetry = await execFileAsync(
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
  const inertCleanupManifest = JSON.parse(inertCleanupRetry.stdout);
  assert.equal(inertCleanupManifest.cleanup, undefined);
  assert.equal(
    inertCleanupManifest.services.backend.cleanupStatus,
    "skipped-stale-identity",
  );

  const retrySession = createManifest({
    sourceRoot,
    sessionId: "dvs-cleanup-retry",
  });
  const retryPaths = resolveSessionPaths(retrySession.devSessionId, env);
  await mkdir(retryPaths.logsDir, { recursive: true, mode: 0o700 });
  const retryProcess = spawnDetached({
    name: "cleanup retry owner",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: sourceRoot,
    env,
    logPath: path.join(retryPaths.logsDir, "cleanup-retry.log"),
  });
  assert.notEqual(retryProcess.processSignature, "");
  retrySession.state = "stopped";
  retrySession.services.frontend = {
    ownership: "dedicated",
    process: { pid: 99_999_999, processSignature: "already stopped" },
    health: "live",
    cleanupStatus: "stopped-identity-verified",
  };
  retrySession.services.backend = {
    ownership: "dedicated",
    process: retryProcess,
    pid: retryProcess.pid,
    url: "http://127.0.0.1:65530",
    lockPath: path.join(retryPaths.sessionDir, "missing-backend.lock"),
    cleanupStatus: "skipped-stale-identity",
  };
  await writeManifest(retrySession, env);
  try {
    const cleanupRetry = await execFileAsync(
      process.execPath,
      [
        "scripts/dev-session/cli.mjs",
        "stop",
        "--session",
        retrySession.devSessionId,
        "--cleanup-stale",
        "--json",
      ],
      { cwd: sourceRoot, env },
    );
    const retriedCleanupManifest = JSON.parse(cleanupRetry.stdout);
    assert.deepEqual(retriedCleanupManifest.cleanup.stoppedServices, [
      "backend",
    ]);
    assert.deepEqual(retriedCleanupManifest.cleanup.skippedStaleServices, []);
    assert.equal(
      retriedCleanupManifest.services.frontend.cleanupStatus,
      "stopped-identity-verified",
    );
    assert.equal(retriedCleanupManifest.services.frontend.health, "live");
    assert.equal(
      retriedCleanupManifest.services.backend.cleanupStatus,
      "stopped-owner-process-identity-verified",
    );
    assert.equal(isProcessLive(retryProcess.pid), false);

    const settledRetry = await execFileAsync(
      process.execPath,
      [
        "scripts/dev-session/cli.mjs",
        "stop",
        "--session",
        retrySession.devSessionId,
        "--cleanup-stale",
        "--json",
      ],
      { cwd: sourceRoot, env },
    );
    const settledCleanupManifest = JSON.parse(settledRetry.stdout);
    assert.equal(settledCleanupManifest.cleanup, undefined);
    assert.equal(
      settledCleanupManifest.services.frontend.cleanupStatus,
      "stopped-identity-verified",
    );
    assert.equal(
      settledCleanupManifest.services.backend.cleanupStatus,
      "stopped-owner-process-identity-verified",
    );
  } finally {
    if (isProcessLive(retryProcess.pid)) {
      process.kill(-retryProcess.pid, "SIGKILL");
    }
  }
}
