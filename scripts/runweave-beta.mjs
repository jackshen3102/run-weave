import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BETA_CHANNEL,
  BetaHealthError,
  buildBetaStatus,
  getGitHead,
  isPidLive,
  readJson,
  resolveBetaPaths,
  writeJson,
} from "./runweave-beta-state.mjs";
import {
  appendFailureDiagnostic,
  buildUpdateEnv,
  collectBaseline,
  formatBetaUpdateFailure,
  openBeta,
  quitBeta,
  recordFailure,
  restoreBaseline,
  runUpdateProcess,
  runAppServerCli,
  waitForHealthyBeta,
} from "./runweave-beta-operations.mjs";
import {
  BETA_SLOT_IDS,
  BETA_SLOT_POLICY,
  applyBetaSlotRetention,
  assertBetaSlotId,
} from "./dev-session/beta-slot-pool.mjs";
import { assertLoopbackUrl } from "./dev-session/contracts.mjs";
import {
  cleanupLegacyBeta,
  inventoryLegacyBeta,
  purgeLegacyBeta,
  restoreLegacyBeta,
} from "./runweave-beta-legacy.mjs";

function parseControlArgs(args) {
  const options = {
    instanceId: "default",
    devSessionId: null,
    desktopCdpPort: 9335,
    terminalBrowserCdpPort: 9336,
    operationId: null,
    confirm: null,
    instanceProvided: false,
    sharedAppServerLockPath: null,
  };
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const option = new Map([
      ["--instance", "instanceId"],
      ["--dev-session", "devSessionId"],
      ["--desktop-cdp-port", "desktopCdpPort"],
      ["--terminal-browser-cdp-port", "terminalBrowserCdpPort"],
      ["--operation", "operationId"],
      ["--confirm", "confirm"],
      ["--shared-app-server-lock-path", "sharedAppServerLockPath"],
    ]).get(arg);
    if (!option) {
      forwarded.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    index += 1;
    options[option] = option.endsWith("Port") ? Number(value) : value;
    if (option === "instanceId") {
      options.instanceProvided = true;
    }
  }
  for (const port of [options.desktopCdpPort, options.terminalBrowserCdpPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid Beta CDP port: ${port}`);
    }
  }
  if (
    options.sharedAppServerLockPath &&
    !path.isAbsolute(options.sharedAppServerLockPath)
  ) {
    throw new Error("shared App Server lock path must be absolute");
  }
  return { forwarded, options };
}

async function resolveSharedAppServer(lockPath) {
  if (!lockPath) {
    return null;
  }
  const resolvedLockPath = path.resolve(lockPath);
  const homeDir = path.dirname(resolvedLockPath);
  const lock = await readJson(resolvedLockPath);
  const token = await fs
    .readFile(path.join(homeDir, "app-server-token"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (
    !Number.isInteger(lock?.pid) ||
    lock.pid <= 0 ||
    !Number.isInteger(lock?.port) ||
    lock.port <= 0 ||
    !token
  ) {
    throw new Error("shared App Server identity is invalid");
  }
  return {
    homeDir,
    lockPath: resolvedLockPath,
    pid: lock.pid,
    token,
    url: assertLoopbackUrl(`http://${lock.host}:${lock.port}`),
  };
}

async function withBetaLock(paths, operation) {
  const lockPaths = [path.join(paths.instanceRoot, "update.lock")];
  const handles = [];
  try {
    for (const lockPath of lockPaths) {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      let handle;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          handle = await fs.open(lockPath, "wx", 0o600);
          break;
        } catch (error) {
          if (error?.code !== "EEXIST") {
            throw error;
          }
          const owner = await readJson(lockPath);
          if (owner && isPidLive(owner.pid)) {
            throw new Error(`Beta update is busy: ${lockPath}`);
          }
          await fs.rm(lockPath, { force: true });
        }
      }
      if (!handle) {
        throw new Error(`failed to acquire Beta update lock: ${lockPath}`);
      }
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      handles.push({ handle, lockPath });
    }
    return await operation();
  } finally {
    for (const { handle, lockPath } of handles.reverse()) {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}

async function update(
  paths,
  args,
  { throwOnFailure = false, sharedAppServer = null } = {},
) {
  const dryRun = args.includes("--dry-run");
  const gitHead = await getGitHead(paths.sourceRoot);
  const env = buildUpdateEnv(
    paths,
    gitHead,
    paths.appBackupPath,
    sharedAppServer,
  );
  if (dryRun) {
    const result = await runUpdateProcess(paths, args, env, null);
    if (!result.ok) {
      process.exitCode = result.code;
    }
    return;
  }

  const startedAt = Date.now();
  const baseline = await collectBaseline(paths);
  baseline.app.backupPath = `${paths.appBackupPath}-${startedAt}`;
  const logPath = path.join(
    paths.logDir,
    `update-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  await writeJson(paths.pendingPath, { baseline, gitHead, logPath, startedAt });

  const result = await runUpdateProcess(
    paths,
    args,
    buildUpdateEnv(paths, gitHead, baseline.app.backupPath, sharedAppServer),
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
    if (throwOnFailure) {
      throw cause;
    }
    process.exitCode = result.code;
    return null;
  }

  const state = (await readJson(paths.statePath)) ?? {};
  if (state.mode !== "app") {
    baseline.app.backupPath = baseline.priorAppBackupPath;
  }
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
    if (paths.slotId) {
      await applyBetaSlotRetention({ slotId: paths.slotId });
    }
    console.log(JSON.stringify(status, null, 2));
    return status;
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
    if (throwOnFailure) {
      throw error;
    }
    process.exitCode = 1;
    return null;
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
    paths.buildRoot,
    paths.cliConfigPath,
    paths.controlCliPath,
    paths.statePath,
    paths.runtimeHome,
    paths.runtimeArtifactsRoot,
    paths.runtimeBuildRoot,
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
  const poolPaths = BETA_SLOT_IDS.map((slotId) =>
    resolveBetaPaths(paths.sourceRoot, os.homedir(), slotId),
  );
  for (const poolPath of poolPaths) {
    if (
      poolPath.runtimeHome.startsWith(`${poolPath.userData}${path.sep}`) ||
      poolPath.statePath.startsWith(`${poolPath.userData}${path.sep}`) ||
      poolPath.instanceId !== poolPath.slotId ||
      poolPath.poolPolicy !== BETA_SLOT_POLICY
    ) {
      throw new Error(
        `Beta pool warm/mutable boundary is invalid: ${poolPath.instanceId}`,
      );
    }
  }
  if (new Set(poolPaths.map((poolPath) => poolPath.appPath)).size !== 5) {
    throw new Error("Beta pool app targets must contain exactly five paths");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        channel: BETA_CHANNEL,
        isolatedPaths: betaPaths,
        statusContract: status,
        poolContract: {
          policy: BETA_SLOT_POLICY,
          capacity: BETA_SLOT_IDS.length,
          slots: poolPaths.map((poolPath) => ({
            slotId: poolPath.slotId,
            appPath: poolPath.appPath,
            instanceRoot: poolPath.instanceRoot,
            runtimeHome: poolPath.runtimeHome,
            statePath: poolPath.statePath,
            userData: poolPath.userData,
            appServerHome: poolPath.appServerHome,
          })),
        },
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { forwarded, options } = parseControlArgs(args);
  if (["update", "open", "rollback"].includes(command)) {
    assertBetaSlotId(options.instanceId);
  }
  if (command === "migrate") {
    throw new Error(
      "legacy Beta migration is retired; use dev:session and legacy-cleanup",
    );
  }
  const paths = resolveBetaPaths(
    process.cwd(),
    os.homedir(),
    options.instanceId,
    options.devSessionId,
    options,
  );
  if (command === "legacy-inventory") {
    console.log(JSON.stringify(await inventoryLegacyBeta(), null, 2));
    return;
  }
  if (command === "legacy-cleanup") {
    if (!options.instanceProvided) {
      throw new Error("legacy-cleanup requires an explicit --instance");
    }
    console.log(
      JSON.stringify(
        await cleanupLegacyBeta({ instanceId: options.instanceId }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "legacy-restore") {
    console.log(
      JSON.stringify(
        await restoreLegacyBeta({ operationId: options.operationId }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "legacy-purge") {
    console.log(
      JSON.stringify(
        await purgeLegacyBeta({
          operationId: options.operationId,
          confirm: options.confirm,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "update") {
    const sharedAppServer = await resolveSharedAppServer(
      options.sharedAppServerLockPath,
    );
    await withBetaLock(paths, () =>
      update(paths, forwarded, {
        sharedAppServer,
      }),
    );
    return;
  }
  if (command === "status") {
    const json = forwarded.includes("--json");
    const status = await buildBetaStatus(paths);
    if (json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
    return;
  }
  if (command === "rollback") {
    await withBetaLock(paths, () => rollback(paths));
    return;
  }
  if (command === "verify") {
    await verify(paths);
    return;
  }
  if (command === "open") {
    await openBeta(paths);
    console.log(JSON.stringify(await buildBetaStatus(paths), null, 2));
    return;
  }
  if (command === "stop") {
    await quitBeta(paths);
    if (!options.sharedAppServerLockPath) {
      const appServerStop = await runAppServerCli(paths, "stop");
      if (!appServerStop.ok && !/not running/i.test(appServerStop.stderr)) {
        throw new Error(
          `failed to stop Beta App Server: ${appServerStop.stderr}`,
        );
      }
    }
    console.log(JSON.stringify(await buildBetaStatus(paths), null, 2));
    return;
  }
  throw new Error(
    "Usage: node scripts/runweave-beta.mjs <update|status|open|stop|rollback|verify|legacy-inventory|legacy-cleanup|legacy-restore|legacy-purge> [--instance id]",
  );
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
