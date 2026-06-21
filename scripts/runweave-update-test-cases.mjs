import assert from "node:assert/strict";
import {
  APP_UPDATE_REASON_NATIVE_CHANGE,
  APP_UPDATE_REASON_NO_STATE,
  APP_UPDATE_REASON_SHELL_VERSION,
  compareVersions,
  incrementMinorVersion,
  isAppSensitivePath,
  parseRunweaveUpdateArgs,
  readDotenvValue,
  resolveAppBuildVersion,
  resolveUpdatePlan,
  RUNWEAVE_CODESIGN_IDENTITY_ENV,
  upsertDotenvValue,
  validateResolvedUpdateOptions,
} from "./runweave-update-core.mjs";

const cases = [
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
        "--no-restart",
        "--dry-run",
      ]);
      assert.equal(
        parsed.sourceRoot,
        "/Users/bytedance/Code/browser-hub/feature",
      );
      assert.equal(parsed.mode, "app");
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
            mode: "runtime",
          },
        }),
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
