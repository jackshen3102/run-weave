import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  BETA_UPDATE_BUILDER_CONFIG,
  APP_SERVER_SKIP_REASON_EXPLICIT,
  APP_SERVER_SKIP_REASON_NO_CHANGE,
  APP_SERVER_UPDATE_REASON_CHANGE,
  APP_SERVER_UPDATE_REASON_EXPLICIT,
  APP_SERVER_UPDATE_REASON_NO_STATE,
  APP_UPDATE_REASON_NATIVE_CHANGE,
  APP_UPDATE_REASON_NO_STATE,
  APP_UPDATE_REASON_SHELL_VERSION,
  compareVersions,
  filterChangedFilesAgainstSnapshot,
  incrementMinorVersion,
  isAppServerSensitivePath,
  isAppSensitivePath,
  parseRunweaveUpdateArgs,
  readDotenvValue,
  resolveAppBuildVersion,
  resolveBetaUpdateTargets,
  resolveUpdatePlan,
  RUNWEAVE_CODESIGN_IDENTITY_ENV,
  upsertDotenvValue,
  validateResolvedUpdateOptions,
  validateUpdateTargetIsolation,
} from "./runweave-update-core.mjs";

const cases = [
  {
    name: "deployed dirty files are excluded until their content changes",
    run() {
      const previousSnapshot = {
        "electron/src/main.ts": "file:420:deployed-shell",
        "frontend/src/App.tsx": "file:420:deployed-runtime",
      };
      assert.deepEqual(
        filterChangedFilesAgainstSnapshot({
          candidateFiles: [
            "electron/src/main.ts",
            "frontend/src/App.tsx",
            "backend/src/index.ts",
          ],
          currentSnapshot: {
            ...previousSnapshot,
            "backend/src/index.ts": "file:420:new-backend",
          },
          previousSnapshot,
        }),
        ["backend/src/index.ts"],
      );
    },
  },
  {
    name: "deployed dirty files re-enter the plan when content changes",
    run() {
      assert.deepEqual(
        filterChangedFilesAgainstSnapshot({
          candidateFiles: ["electron/src/main.ts"],
          currentSnapshot: {
            "electron/src/main.ts": "file:420:next-shell",
          },
          previousSnapshot: {
            "electron/src/main.ts": "file:420:deployed-shell",
          },
        }),
        ["electron/src/main.ts"],
      );
    },
  },
  {
    name: "auto uses full app update when no previous state exists",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: ["frontend/src/App.tsx"],
        hasPreviousState: false,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "app");
      assert.equal(plan.reason, APP_UPDATE_REASON_NO_STATE);
      assert.equal(plan.appServer.action, "update");
      assert.equal(plan.appServer.reason, APP_SERVER_UPDATE_REASON_NO_STATE);
    },
  },
  {
    name: "auto uses runtime update for frontend/backend changes after baseline",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: [
          "frontend/src/App.tsx",
          "backend/src/routes/health.ts",
          "packages/shared/src/runtime-monitor.ts",
        ],
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "runtime");
      assert.deepEqual(plan.nativeFiles, []);
      assert.equal(plan.appServer.action, "skip");
      assert.equal(plan.appServer.reason, APP_SERVER_SKIP_REASON_NO_CHANGE);
    },
  },
  {
    name: "auto updates app-server as a separate component for app-server changes",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: [
          "app-server/src/index.ts",
          "packages/shared/src/app-server-node.ts",
        ],
        hasPreviousAppServerState: true,
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "runtime");
      assert.equal(plan.appServer.action, "update");
      assert.equal(plan.appServer.reason, APP_SERVER_UPDATE_REASON_CHANGE);
      assert.deepEqual(plan.appServer.changedFiles, [
        "app-server/src/index.ts",
        "packages/shared/src/app-server-node.ts",
      ]);
    },
  },
  {
    name: "explicit app-server mode can force update or skip independently",
    run() {
      const forcedUpdate = resolveUpdatePlan({
        appServerMode: "update",
        changedFiles: ["frontend/src/App.tsx"],
        hasPreviousAppServerState: true,
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(forcedUpdate.mode, "runtime");
      assert.equal(forcedUpdate.appServer.action, "update");
      assert.equal(
        forcedUpdate.appServer.reason,
        APP_SERVER_UPDATE_REASON_EXPLICIT,
      );

      const forcedSkip = resolveUpdatePlan({
        appServerMode: "skip",
        changedFiles: ["app-server/src/index.ts"],
        hasPreviousAppServerState: false,
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(forcedSkip.mode, "runtime");
      assert.equal(forcedSkip.appServer.action, "skip");
      assert.equal(
        forcedSkip.appServer.reason,
        APP_SERVER_SKIP_REASON_EXPLICIT,
      );
    },
  },
  {
    name: "auto uses full app update for Electron main process changes",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: ["electron/src/main.ts"],
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "app");
      assert.equal(plan.reason, APP_UPDATE_REASON_NATIVE_CHANGE);
      assert.deepEqual(plan.nativeFiles, ["electron/src/main.ts"]);
    },
  },
  {
    name: "auto uses full app update when source shell version is newer",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: ["frontend/src/App.tsx"],
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.125.0",
      });
      assert.equal(plan.mode, "app");
      assert.equal(plan.reason, APP_UPDATE_REASON_SHELL_VERSION);
    },
  },
  {
    name: "auto can use runtime when installed app version is newer than source package",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: ["frontend/src/App.tsx"],
        hasPreviousState: true,
        installedAppVersion: "0.125.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "runtime");
    },
  },
  {
    name: "explicit runtime mode overrides native file detection",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: ["electron/src/main.ts"],
        forceMode: "runtime",
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "runtime");
      assert.deepEqual(plan.nativeFiles, ["electron/src/main.ts"]);
    },
  },
  {
    name: "app build version is newer than the installed version",
    run() {
      assert.equal(
        resolveAppBuildVersion({
          installedAppVersion: "0.124.0",
          sourceShellVersion: "0.124.0",
        }),
        "0.125.0",
      );
      assert.equal(
        resolveAppBuildVersion({
          installedAppVersion: "0.124.0",
          sourceShellVersion: "0.126.0",
        }),
        "0.126.0",
      );
      assert.equal(incrementMinorVersion("1.2.3"), "1.3.0");
      assert.equal(compareVersions("0.126.0", "0.124.0"), 1);
    },
  },
  {
    name: "argument parser accepts cross-worktree update options",
    run() {
      const parsed = parseRunweaveUpdateArgs([
        "--repo",
        "/Users/bytedance/Code/browser-hub/feature",
        "--mode=app",
        "--app-server=update",
        "--app-server-home",
        "/Users/bytedance/.runweave/app-server-test",
        "--no-restart",
        "--dry-run",
      ]);
      assert.equal(
        parsed.sourceRoot,
        "/Users/bytedance/Code/browser-hub/feature",
      );
      assert.equal(parsed.mode, "app");
      assert.equal(parsed.appServerMode, "update");
      assert.equal(
        parsed.appServerHome,
        "/Users/bytedance/.runweave/app-server-test",
      );
      assert.equal(parsed.noRestart, true);
      assert.equal(parsed.dryRun, true);
    },
  },
  {
    name: "no-restart is rejected for app update plans",
    run() {
      assert.throws(
        () =>
          validateResolvedUpdateOptions({
            noRestart: true,
            plan: {
              mode: "app",
            },
          }),
        /--no-restart is only supported for runtime updates/,
      );
      assert.doesNotThrow(() =>
        validateResolvedUpdateOptions({
          noRestart: true,
          plan: {
            appServer: { action: "skip" },
            mode: "runtime",
          },
        }),
      );
    },
  },
  {
    name: "no-restart is rejected for app-server update plans",
    run() {
      assert.throws(
        () =>
          validateResolvedUpdateOptions({
            noRestart: true,
            plan: {
              appServer: { action: "update" },
              mode: "runtime",
            },
          }),
        /cannot be combined with an App Server update/,
      );
      assert.doesNotThrow(() =>
        validateResolvedUpdateOptions({
          noRestart: true,
          plan: {
            appServer: { action: "skip" },
            mode: "runtime",
          },
        }),
      );
    },
  },
  {
    name: "beta update target isolation rejects every mismatched identity and path",
    run() {
      const homeDir = "/tmp/runweave-test-home";
      const targets = resolveBetaUpdateTargets(homeDir);
      const valid = {
        appBackupPath:
          "/Applications/.Runweave Beta default.app.previous-123",
        appName: targets.appName,
        appPath: targets.appPath,
        appServerHome: targets.appServerHome,
        channel: "beta",
        electronBuilderConfig: BETA_UPDATE_BUILDER_CONFIG,
        homeDir,
        runtimeHome: targets.runtimeHome,
        statePath: targets.statePath,
      };
      assert.doesNotThrow(() => validateUpdateTargetIsolation(valid));
      assert.doesNotThrow(() =>
        validateUpdateTargetIsolation({
          ...valid,
          appName: "Custom Stable Test App",
          appPath: "/tmp/stable-test.app",
          appServerHome: "/tmp/app-server-test",
          channel: "stable",
          electronBuilderConfig: "custom-builder.yml",
          runtimeHome: "/tmp/runtime-test",
          statePath: "/tmp/state-test.json",
        }),
      );

      const mismatches = [
        ["appName", "Runweave", /app name must be Runweave Beta default/],
        [
          "appPath",
          "/Applications/Runweave.app",
          /app path must be \/Applications\/Runweave Beta default\.app/,
        ],
        [
          "runtimeHome",
          "/tmp/runweave-test-home/Library/Application Support/@runweave/electron/runtime",
          /runtime home must be .*Runweave Beta\/instances\/default\/user-data\/runtime/,
        ],
        [
          "appServerHome",
          "/tmp/runweave-test-home/.runweave/app-server",
          /App Server home must be .*app-server-beta/,
        ],
        [
          "statePath",
          "/tmp/runweave-test-home/Library/Application Support/RunweaveLocalUpdate/state.json",
          /state path must be .*Runweave Beta\/instances\/default\/user-data\/update\/state\.json/,
        ],
        [
          "electronBuilderConfig",
          "electron-builder.local-updates.yml",
          /Electron builder config must be electron-builder\.beta\.yml/,
        ],
        [
          "appBackupPath",
          "/Applications/Runweave.app",
          /app backup path must be \/Applications\/\.Runweave Beta default\.app\.previous/,
        ],
      ];
      for (const [key, value, message] of mismatches) {
        assert.throws(
          () => validateUpdateTargetIsolation({ ...valid, [key]: value }),
          message,
        );
      }

      const directEnv = {
        ...process.env,
        HOME: homeDir,
        RUNWEAVE_UPDATE_TARGET: "beta",
      };
      for (const name of [
        "RUNWEAVE_APP_BACKUP_PATH",
        "RUNWEAVE_APP_SERVER_HOME",
        "RUNWEAVE_ELECTRON_BUILDER_CONFIG",
        "RUNWEAVE_LOCAL_UPDATE_APP_NAME",
        "RUNWEAVE_RUNTIME_HOME",
        "RUNWEAVE_UPDATE_STATE_PATH",
      ]) {
        delete directEnv[name];
      }
      const directInvocation = spawnSync(
        process.execPath,
        ["./scripts/runweave-update.mjs", "--dry-run"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: directEnv,
        },
      );
      assert.equal(directInvocation.status, 1);
      assert.equal(directInvocation.stdout, "");
      assert.match(
        directInvocation.stderr,
        /Refusing Beta update: runtime home must be/,
      );
    },
  },
  {
    name: "native-sensitive path matcher covers update scripts, resources, and builder config",
    run() {
      assert.equal(isAppSensitivePath("scripts/runweave-update.mjs"), true);
      assert.equal(
        isAppSensitivePath("scripts/runweave-update-core.mjs"),
        true,
      );
      assert.equal(
        isAppSensitivePath("electron/resources/icons/icon.icns"),
        true,
      );
      assert.equal(isAppSensitivePath("electron/electron-builder.yml"), true);
      assert.equal(isAppSensitivePath("backend/src/index.ts"), false);
      assert.equal(isAppServerSensitivePath("app-server/src/index.ts"), true);
      assert.equal(
        isAppServerSensitivePath("packages/shared/src/app-server-node.ts"),
        true,
      );
      assert.equal(isAppServerSensitivePath("frontend/src/App.tsx"), false);
    },
  },
  {
    name: "auto uses full app update for one-command update script changes",
    run() {
      const plan = resolveUpdatePlan({
        changedFiles: ["scripts/runweave-update.mjs"],
        hasPreviousState: true,
        installedAppVersion: "0.124.0",
        sourceShellVersion: "0.124.0",
      });
      assert.equal(plan.mode, "app");
      assert.equal(plan.reason, APP_UPDATE_REASON_NATIVE_CHANGE);
      assert.deepEqual(plan.nativeFiles, ["scripts/runweave-update.mjs"]);
    },
  },
  {
    name: "dotenv codesign identity is read and updated without dropping other keys",
    run() {
      const original = [
        "AUTH_USERNAME=admin",
        `${RUNWEAVE_CODESIGN_IDENTITY_ENV}="Old Identity"`,
        "AUTH_PASSWORD=secret",
        "",
      ].join("\n");
      const updated = upsertDotenvValue(
        original,
        RUNWEAVE_CODESIGN_IDENTITY_ENV,
        "Apple Development: user@example.com (TEAMID)",
      );

      assert.equal(
        readDotenvValue(updated, RUNWEAVE_CODESIGN_IDENTITY_ENV),
        "Apple Development: user@example.com (TEAMID)",
      );
      assert.match(updated, /AUTH_USERNAME=admin/);
      assert.match(updated, /AUTH_PASSWORD=secret/);
    },
  },
];

for (const testCase of cases) {
  testCase.run();
  console.log(`[runweave-update:test] PASS ${testCase.name}`);
}

console.log(`[runweave-update:test] ${cases.length} case(s) passed`);
