import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BETA_APP_NAME,
  BETA_CHANNEL,
  BetaHealthError,
  buildBetaStatus,
  getGitHead,
  readJson,
  resolveBetaPaths,
  writeJson,
} from "./runweave-beta-state.mjs";
import {
  appendFailureDiagnostic,
  buildUpdateEnv,
  collectBaseline,
  formatBetaUpdateFailure,
  recordFailure,
  restoreBaseline,
  runUpdateProcess,
  waitForHealthyBeta,
} from "./runweave-beta-operations.mjs";

async function update(paths, args) {
  const dryRun = args.includes("--dry-run");
  const gitHead = await getGitHead(paths.sourceRoot);
  const env = buildUpdateEnv(paths, gitHead);
  if (dryRun) {
    const result = await runUpdateProcess(paths, args, env, null);
    if (!result.ok) {
      process.exitCode = result.code;
    }
    return;
  }

  const startedAt = Date.now();
  const baseline = await collectBaseline(paths);
  baseline.app.backupPath = path.join(
    "/Applications",
    `.${BETA_APP_NAME}.app.previous-${startedAt}`,
  );
  const logPath = path.join(
    paths.logDir,
    `update-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  await writeJson(paths.pendingPath, { baseline, gitHead, logPath, startedAt });

  const result = await runUpdateProcess(
    paths,
    args,
    buildUpdateEnv(paths, gitHead, baseline.app.backupPath),
    logPath,
  );
  if (!result.ok) {
    const cause = new Error(`update process exited with code ${result.code}`);
    let recovery = "automatic-restore-failed";
    try {
      await restoreBaseline(paths, baseline);
      recovery = "automatic-restore-applied";
    } finally {
      const diagnostic = formatBetaUpdateFailure({
        baseline,
        cause,
        logPath,
        recovery,
        unhealthyComponents: ["update-process"],
      });
      console.error(diagnostic);
      await appendFailureDiagnostic(logPath, diagnostic);
      await recordFailure(paths, baseline, logPath, cause.message);
      await fs.rm(paths.pendingPath, { force: true });
    }
    process.exitCode = result.code;
    return;
  }

  const state = (await readJson(paths.statePath)) ?? {};
  await writeJson(paths.statePath, {
    ...state,
    channel: BETA_CHANNEL,
    previous: baseline,
    logPath,
    lastFailure: null,
  });
  if (
    state.mode === "app" &&
    baseline.priorAppBackupPath &&
    baseline.priorAppBackupPath !== baseline.app.backupPath
  ) {
    await fs.rm(baseline.priorAppBackupPath, { force: true, recursive: true });
  }
  await fs.rm(paths.pendingPath, { force: true });

  try {
    const status = await waitForHealthyBeta(
      paths,
      state.appServerAction === "update",
      startedAt,
    );
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    let recovery = "automatic-restore-failed";
    try {
      await restoreBaseline(paths, baseline);
      recovery = "automatic-restore-applied";
    } finally {
      const diagnostic = formatBetaUpdateFailure({
        baseline,
        cause: error,
        logPath,
        recovery,
        unhealthyComponents:
          error instanceof BetaHealthError
            ? error.unhealthyComponents
            : ["beta-update"],
      });
      console.error(diagnostic);
      await appendFailureDiagnostic(logPath, diagnostic);
      await recordFailure(
        paths,
        baseline,
        logPath,
        error instanceof Error ? error.message : String(error),
      );
    }
    process.exitCode = 1;
  }
}

async function rollback(paths) {
  const state = await readJson(paths.statePath);
  const baseline = state?.previous;
  if (!baseline?.app || !("runtimeReleaseId" in baseline)) {
    throw new Error("No previous Beta release is available for rollback");
  }
  const restored = await restoreBaseline(paths, baseline, {
    forceApp: state.mode === "app",
  });
  await writeJson(paths.statePath, {
    ...state,
    appServerReleaseId: baseline.appServerReleaseId,
    appVersion: baseline.app.version,
    gitDirty: baseline.source?.gitDirty ?? null,
    gitHead: baseline.source?.gitHead ?? null,
    lastFailure: null,
    mode: "rollback",
    runtimeReleaseId: baseline.runtimeReleaseId,
    sourceRoot: baseline.source?.sourceRoot ?? paths.sourceRoot,
    updatedAt: new Date().toISOString(),
    worktreeSnapshot: baseline.source?.worktreeSnapshot ?? null,
    rolledBackAt: new Date().toISOString(),
    rollback: restored,
  });
  const status = await waitForHealthyBeta(
    paths,
    Boolean(baseline.appServerReleaseId),
    Date.now() - 1_000,
  );
  console.log(JSON.stringify(status, null, 2));
}

async function verify(paths) {
  const stablePaths = [
    "/Applications/Runweave.app",
    path.join(os.homedir(), ".runweave", "app-server"),
    path.join(os.homedir(), ".runweave", "config.json"),
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "RunweaveLocalUpdate",
      "state.json",
    ),
  ];
  const betaPaths = [
    paths.appPath,
    paths.appServerHome,
    paths.cliConfigPath,
    paths.statePath,
    paths.runtimeHome,
    paths.profileDir,
  ];
  if (betaPaths.some((entry) => stablePaths.includes(entry))) {
    throw new Error("Beta configuration overlaps a Stable writable path");
  }
  const builderConfig = await fs.readFile(
    path.join(paths.sourceRoot, "electron", "electron-builder.beta.yml"),
    "utf8",
  );
  for (const marker of [
    "com.runweave.desktop.beta",
    "productName: Runweave Beta",
  ]) {
    if (!builderConfig.includes(marker)) {
      throw new Error(`Beta builder config is missing ${marker}`);
    }
  }
  const status = await buildBetaStatus(paths);
  const serialized = JSON.stringify(status);
  if (/authorization|cookie|jwt|password|token/i.test(serialized)) {
    throw new Error("Beta status contains a sensitive field name");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        channel: BETA_CHANNEL,
        isolatedPaths: betaPaths,
        statusContract: status,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const paths = resolveBetaPaths();
  if (command === "update") {
    await update(paths, args);
    return;
  }
  if (command === "status") {
    const json = args.includes("--json");
    const status = await buildBetaStatus(paths);
    if (json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
    return;
  }
  if (command === "rollback") {
    await rollback(paths);
    return;
  }
  if (command === "verify") {
    await verify(paths);
    return;
  }
  throw new Error(
    "Usage: node scripts/runweave-beta.mjs <update|status|rollback|verify>",
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
