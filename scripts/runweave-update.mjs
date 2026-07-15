import os from "node:os";
import path from "node:path";
import {
  parseRunweaveUpdateArgs,
  resolveAppBuildVersion,
  resolveDefaultRuntimeHome,
  resolveDefaultUpdateStatePath,
  resolveUpdatePlan,
  validateResolvedUpdateOptions,
  validateUpdateTargetIsolation,
} from "./runweave-update-core.mjs";
import {
  appName,
  channel,
  electronBuilderConfig,
  isBetaTarget,
  isBetaTerminal,
} from "./runweave-update-context.mjs";
import {
  createWorktreeSnapshot,
  getGitChangedFilesSinceState,
  getGitHead,
  getGitStatusDirty,
  readInstalledMacAppVersion,
  readJsonFile,
  readPackageVersion,
  resolveCodesignIdentity,
} from "./runweave-update-system.mjs";
import {
  openApp,
  restartApp,
  runAppServerUpdate,
  runAppUpdate,
  runRuntimeUpdate,
  writeUpdateState,
} from "./runweave-update-operations.mjs";

async function main() {
  const args = parseRunweaveUpdateArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(args.sourceRoot);
  const appPath = path.resolve(args.appPath ?? `/Applications/${appName}.app`);
  const ambientRuntimeHome = isBetaTerminal
    ? null
    : process.env.RUNWEAVE_RUNTIME_HOME;
  const ambientAppServerHome = isBetaTerminal
    ? null
    : process.env.RUNWEAVE_APP_SERVER_HOME;
  const ambientStatePath = isBetaTerminal
    ? null
    : process.env.RUNWEAVE_UPDATE_STATE_PATH;
  const runtimeHome = path.resolve(
    args.runtimeHome ?? ambientRuntimeHome ?? resolveDefaultRuntimeHome(),
  );
  const appServerHome = path.resolve(
    args.appServerHome ??
      ambientAppServerHome ??
      path.join(os.homedir(), ".runweave", "app-server"),
  );
  const statePath = path.resolve(
    args.statePath ?? ambientStatePath ?? resolveDefaultUpdateStatePath(),
  );
  const appBackupPath =
    isBetaTarget && process.env.RUNWEAVE_APP_BACKUP_PATH
      ? path.resolve(process.env.RUNWEAVE_APP_BACKUP_PATH)
      : null;
  validateUpdateTargetIsolation({
    appBackupPath,
    appName,
    appPath,
    appServerHome,
    channel,
    electronBuilderConfig,
    instanceId: process.env.RUNWEAVE_DESKTOP_INSTANCE_ID ?? "default",
    runtimeHome,
    statePath,
  });
  const state = readJsonFile(statePath);
  const sourceShellVersion = readPackageVersion(
    path.join(sourceRoot, "electron", "package.json"),
  );
  const installedAppVersion = await readInstalledMacAppVersion(appPath);
  const changedFiles = await getGitChangedFilesSinceState(sourceRoot, state);
  const plan = resolveUpdatePlan({
    appServerMode: args.appServerMode,
    changedFiles,
    forceMode: args.mode,
    hasPreviousAppServerState: Boolean(
      state?.appServerReleaseId ??
      state?.appServer?.releaseId ??
      state?.appServer?.action,
    ),
    hasPreviousState: Boolean(state?.gitHead),
    installedAppVersion,
    sourceShellVersion,
  });
  validateResolvedUpdateOptions({
    noRestart: args.noRestart,
    plan,
    verifyDesktop: args.verifyDesktop,
  });
  const gitHead = await getGitHead(sourceRoot);
  const gitDirty = await getGitStatusDirty(sourceRoot);
  const worktreeSnapshot = await createWorktreeSnapshot(sourceRoot);
  let codesignIdentity = await resolveCodesignIdentity(sourceRoot, {
    persistConfig: !args.dryRun,
  });
  const appBuildVersion = resolveAppBuildVersion({
    installedAppVersion,
    sourceShellVersion,
  });
  const desktopVerification = args.verifyDesktop
    ? {
        appServerHome,
        expectedAppVersion:
          plan.mode === "app" ? appBuildVersion : installedAppVersion,
        runtimeHome,
        statusPath: path.join(
          path.dirname(statePath),
          "desktop-verification.json",
        ),
      }
    : null;

  console.log(`[runweave-update] channel: ${channel}`);
  console.log(`[runweave-update] source: ${sourceRoot}`);
  console.log(`[runweave-update] installed app: ${appPath}`);
  console.log(`[runweave-update] runtime home: ${runtimeHome}`);
  console.log(`[runweave-update] update state: ${statePath}`);
  console.log(
    `[runweave-update] installed version: ${installedAppVersion ?? "unknown"}`,
  );
  console.log(
    `[runweave-update] source shell version: ${sourceShellVersion ?? "unknown"}`,
  );
  console.log(`[runweave-update] selected mode: ${plan.mode}`);
  console.log(`[runweave-update] reason: ${plan.reason}`);
  console.log(`[runweave-update] app-server home: ${appServerHome}`);
  console.log(
    `[runweave-update] selected app-server action: ${plan.appServer.action}`,
  );
  console.log(`[runweave-update] app-server reason: ${plan.appServer.reason}`);
  console.log(
    `[runweave-update] desktop verification: ${desktopVerification ? desktopVerification.statusPath : "disabled"}`,
  );
  if (plan.mode === "app") {
    console.log(
      `[runweave-update] codesign identity: ${codesignIdentity.identity ?? "ad-hoc"} (${codesignIdentity.source})`,
    );
  }
  if (plan.nativeFiles.length > 0) {
    console.log(
      `[runweave-update] native-sensitive changes: ${plan.nativeFiles.join(", ")}`,
    );
  }
  if (plan.appServer.changedFiles.length > 0) {
    console.log(
      `[runweave-update] app-server changes: ${plan.appServer.changedFiles.join(", ")}`,
    );
  }

  if (args.dryRun) {
    console.log("[runweave-update] dry run complete");
    return;
  }

  let runtimeRelease = null;
  let appServerRelease = null;
  let desktopVerificationResult = null;
  const previousAppServerReleaseId =
    state?.appServerReleaseId ?? state?.appServer?.releaseId ?? null;
  const deferBetaRestartUntilAppServer =
    isBetaTarget && plan.appServer.action === "update" && !args.noRestart;
  if (plan.mode === "runtime") {
    runtimeRelease = await runRuntimeUpdate({
      channel,
      gitHead,
      installedAppVersion,
      runtimeHome,
      sourceRoot,
    });
    if (!args.noRestart && !deferBetaRestartUntilAppServer) {
      desktopVerificationResult = await restartApp(appPath, {
        desktopVerification,
      });
    }
  } else {
    try {
      desktopVerificationResult = await runAppUpdate({
        appBackupPath,
        appBuildVersion,
        appPath,
        channel,
        codesignIdentity: codesignIdentity.identity,
        gitHead,
        launchAfterInstall: !deferBetaRestartUntilAppServer,
        desktopVerification,
        sourceRoot,
      });
    } catch (error) {
      if (!codesignIdentity.identity) {
        throw error;
      }
      console.warn(
        `[runweave-update] app update failed with codesign identity ${codesignIdentity.identity}; refreshing identity once`,
      );
      codesignIdentity = await resolveCodesignIdentity(sourceRoot, {
        exclude: [codesignIdentity.identity],
      });
      if (!codesignIdentity.identity) {
        throw error;
      }
      desktopVerificationResult = await runAppUpdate({
        appBackupPath,
        appBuildVersion,
        appPath,
        channel,
        codesignIdentity: codesignIdentity.identity,
        gitHead,
        launchAfterInstall: !deferBetaRestartUntilAppServer,
        desktopVerification,
        sourceRoot,
      });
    }
  }
  if (plan.appServer.action === "update") {
    appServerRelease = await runAppServerUpdate({
      appServerHome,
      controlCliPath:
        process.env.RUNWEAVE_CLI_BUNDLE_OUTFILE?.trim() || null,
      sourceRoot,
    });
  }
  if (deferBetaRestartUntilAppServer) {
    if (plan.mode === "runtime") {
      desktopVerificationResult = await restartApp(appPath, {
        desktopVerification,
      });
    } else {
      desktopVerificationResult = await openApp(appPath, {
        desktopVerification,
      });
    }
  }
  const nextInstalledVersion = await readInstalledMacAppVersion(appPath);
  await writeUpdateState(statePath, {
    channel,
    appServer: {
      action: plan.appServer.action,
      changedFiles: plan.appServer.changedFiles,
      home: appServerHome,
      reason: plan.appServer.reason,
      releaseId: appServerRelease?.releaseId ?? previousAppServerReleaseId,
      status: appServerRelease?.status ?? null,
    },
    appServerAction: plan.appServer.action,
    appServerHome,
    appServerReason: plan.appServer.reason,
    appServerReleaseId:
      appServerRelease?.releaseId ?? previousAppServerReleaseId,
    appPath,
    appVersion: nextInstalledVersion ?? installedAppVersion,
    gitDirty,
    gitHead,
    mode: plan.mode,
    nativeFiles: plan.nativeFiles,
    reason: plan.reason,
    codesignIdentity: plan.mode === "app" ? codesignIdentity.identity : null,
    codesignIdentitySource:
      plan.mode === "app" ? codesignIdentity.source : null,
    desktopVerification: desktopVerificationResult,
    runtimeHome,
    runtimeReleaseId: runtimeRelease?.releaseId ?? null,
    sourceRoot,
    updatedAt: new Date().toISOString(),
    worktreeSnapshot,
  });

  if (desktopVerificationResult) {
    console.log(
      `[runweave-update] desktop verification ready: ${JSON.stringify(desktopVerificationResult)}`,
    );
  }

  console.log("[runweave-update] done");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
