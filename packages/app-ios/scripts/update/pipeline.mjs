import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { acquireLock } from "../device/lock.mjs";
import { preflight } from "../device/preflight.mjs";
import { installAndLaunch } from "./install.mjs";
import {
  bundleID,
  command,
  DeviceError,
  deviceQuery,
  hash,
  pkg,
  project,
  readJSON,
  writeJSON,
} from "../device/support.mjs";
import {
  acquireStateLock,
  allocateVersion,
  previewNewVersion,
  buildLockName,
  buildNumber,
  compareVersions,
  saveTarget,
  validVersion,
} from "./state.mjs";

const repository = resolve(pkg, "../..");
const identityCLI = resolve(repository, "scripts/ios-build/cli.py");
const versionOf = (app) => ({
  version: app?.version ?? null,
  buildNumber: app?.bundleVersion ?? null,
  installationURL: app?.url ?? null,
});

export async function update(options) {
  const runId = randomUUID();
  const dryRun = Boolean(options["dry-run"]);
  const dir = dryRun
    ? mkdtempSync(resolve(tmpdir(), "runweave-ios-preview-"))
    : resolve(repository, ".runweave/ios-updates", runId);
  const result = {
    schemaVersion: 1,
    runId,
    state: "running",
    exitCode: 0,
    device: options.device,
    configuration: options.configuration,
    evidencePath: dryRun ? null : dir,
    uiVerified: false,
    build: "not_started",
    install: "not_started",
    launch: "not_started",
  };
  let phase = "checking",
    deviceLock,
    releaseBuildLock;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const progress = (message) => console.error(`[ios-update] ${message}`);
  const fail = (reason, action, code) => {
    throw new DeviceError(reason, phase, action, code, dir);
  };
  const checked = async (program, args, name, timeout = 60000, code = 3) => {
    if (controller.signal.aborted)
      fail(
        "interrupted",
        "Retry the same command after inspecting this run",
        code,
      );
    const value = await command(program, args, {
      dir,
      name,
      timeout,
      owner: deviceLock,
      signal: controller.signal,
    });
    if (!value.ok)
      fail(
        `${name}_failed`,
        `Inspect ${value.evidencePath}; retry after resolving the error`,
        code,
      );
    return value.output;
  };
  const source = async () =>
    JSON.parse(
      await checked(
        "python3",
        ["-B", identityCLI, "source", "--app", "runweave"],
        "source",
        60000,
        4,
      ),
    );
  const inspect = async (appPath) =>
    JSON.parse(
      await checked(
        "python3",
        ["-B", identityCLI, "inspect", "--app-path", appPath],
        "inspect",
        60000,
        4,
      ),
    );
  const waitForUnlock = async (report, stage) => {
    const blocked = report.checks.filter((check) => check.status === "blocked");
    if (
      dryRun ||
      !blocked.length ||
      blocked.some((check) => check.reason !== "device_locked")
    )
      return report;
    const deadline = Date.now() + 120000;
    let reminderAt = 0;
    while (Date.now() < deadline && !controller.signal.aborted) {
      if (Date.now() >= reminderAt) {
        progress("手机已锁屏，请解锁；命令最多等待 120 秒，解锁后自动继续");
        reminderAt = Date.now() + 30000;
      }
      const lock = await deviceQuery(
        "lockState",
        options.device,
        resolve(dir, `unlock-${stage}`),
        5000,
        deviceLock,
      );
      if (
        lock.ok &&
        lock.value.passcodeRequired === false &&
        lock.value.unlockedSinceBoot === true
      )
        return preflight(
          options,
          resolve(dir, `ready-${stage}`),
          deviceLock ? runId : undefined,
        );
      await new Promise((done) => setTimeout(done, 2000));
    }
    fail(
      controller.signal.aborted ? "interrupted" : "device_locked",
      "Unlock the target iPhone and rerun the same update command",
      3,
    );
  };
  try {
    progress(`检查 ${options.device}（${options.configuration}）`);
    const report = await waitForUnlock(
      await preflight(options, dir),
      "initial",
    );
    result.preflight = report.checks
      .filter((check) => check.status === "blocked")
      .map(({ id, reason }) => ({ id, reason }));
    if (report.state === "blocked")
      fail(report.error.reason, report.nextAction, 3);
    options.team = report.team;
    result.team = options.team;
    result.transport = report.device.transport ?? null;
    result.name = report.device.name;
    const installed = report.checks.find((c) => c.id === "installed_app");
    if (installed.status !== "pass")
      fail(
        "app_metadata_unavailable",
        "Restore device connectivity and retry",
        3,
      );
    result.before = versionOf(installed.value);
    if (!dryRun) {
      deviceLock = acquireLock(options.device, runId);
      releaseBuildLock = acquireStateLock(buildLockName(), runId);
    }
    phase = "planning";
    const buildRoot = resolve(
      pkg,
      ".build/ios/update",
      `${options.configuration}-${options.team}`,
    );
    const flags = [
      "-project",
      project,
      "-scheme",
      "RunweaveNative",
      "-configuration",
      options.configuration,
      "-destination",
      `platform=iOS,id=${options.device}`,
      "-derivedDataPath",
      buildRoot,
      `DEVELOPMENT_TEAM=${options.team}`,
      // Direct device installs use development signing, even for optimized Release builds.
      "CODE_SIGN_STYLE=Automatic",
      "CODE_SIGN_IDENTITY=Apple Development",
      "APS_ENVIRONMENT=development",
      "RUNWEAVE_APNS_ENVIRONMENT=sandbox",
    ];
    // Preview does not resolve packages or create DerivedData; read configured defaults directly.
    if (dryRun) {
      const text = await checked(
        "python3",
        [
          "-c",
          "import pathlib,json,re,sys; s=pathlib.Path(sys.argv[1]).read_text(); print(json.dumps({k:list(set(re.findall(k+r'\\s*=\\s*([^;]+);',s))) for k in ['MARKETING_VERSION','CURRENT_PROJECT_VERSION']}))",
          resolve(project, "project.pbxproj"),
        ],
        "version-defaults",
      );
      const defaults = JSON.parse(text);
      if (
        defaults.MARKETING_VERSION.length !== 1 ||
        defaults.CURRENT_PROJECT_VERSION.length !== 1
      )
        fail(
          "ambiguous_version_defaults",
          "Align project defaults or inspect configuration-specific settings",
          2,
        );
      const baseVersion = defaults.MARKETING_VERSION[0].trim();
      if (!validVersion(baseVersion))
        fail("invalid_product_version", "Provide --version X.Y.Z", 2);
      if (
        options.version &&
        result.before.version &&
        compareVersions(options.version, result.before.version) < 0
      )
        fail(
          "version_downgrade",
          "Use --version at least as high as the installed product version",
          2,
        );
      result.plan = {
        baseVersion,
        newBuildVersion:
          options.version ||
          previewNewVersion(baseVersion, result.before.version),
        versionPolicy:
          "reuse verified product version or increment patch for a new build",
        buildNumber:
          "reuse verified product or allocate above local/project/device maximum",
        configuration: options.configuration,
        analytics:
          options.configuration === "Release"
            ? "production"
            : "disabled by project default",
        apns: "sandbox",
        steps: [
          "verify inputs",
          "build or reuse signed product",
          "install",
          "verify installed version",
          "launch and check process",
        ],
      };
      result.state = "planned";
      return result;
    }
    const snapshot = await source();
    const settingsOutput = await checked(
      "xcodebuild",
      [...flags, "-showBuildSettings", "-json"],
      "build-settings",
      180000,
      4,
    );
    // Xcode writes package resolution progress before its JSON array on some versions.
    const settingsStart = settingsOutput.search(/^\s*\[\s*\{/m);
    if (settingsStart < 0)
      fail("build_settings_unreadable", "Inspect build-settings.log", 4);
    const settingsJSON = JSON.parse(settingsOutput.slice(settingsStart));
    const settings = settingsJSON.find(
      (target) => target.target === "RunweaveNative",
    )?.buildSettings;
    if (!settings || settings.PRODUCT_BUNDLE_IDENTIFIER !== bundleID)
      fail("bundle_settings_mismatch", "Inspect build-settings.log", 4);
    const baseVersion = settings.MARKETING_VERSION;
    if (!validVersion(baseVersion))
      fail("invalid_product_version", "Provide --version X.Y.Z", 2);
    if (
      options.version &&
      result.before.version &&
      compareVersions(options.version, result.before.version) < 0
    )
      fail(
        "version_downgrade",
        "Use --version at least as high as the installed product version",
        2,
      );
    const minimumOS =
      settings.IPHONEOS_DEPLOYMENT_TARGET.split(".").map(Number);
    const deviceOS = report.device.osVersion.split(".").map(Number);
    if (
      minimumOS.some(
        (n, i) =>
          n !== (deviceOS[i] || 0) &&
          minimumOS.slice(0, i).every((p, j) => p === (deviceOS[j] || 0)) &&
          n > (deviceOS[i] || 0),
      )
    )
      fail(
        "incompatible_device_os",
        `Target requires iOS ${settings.IPHONEOS_DEPLOYMENT_TARGET}`,
        3,
      );
    const minimum = Math.max(
      buildNumber(settings.CURRENT_PROJECT_VERSION),
      result.before.buildNumber === null
        ? 0
        : buildNumber(result.before.buildNumber),
    );
    result.analytics = {
      enabled: settings.RUNWEAVE_CLARITY_ENABLED === "YES",
      projectID: settings.RUNWEAVE_CLARITY_PROJECT_ID || null,
    };
    result.apns = settings.RUNWEAVE_APNS_ENVIRONMENT ?? null;
    progress(
      `版本策略 ${options.version || "新构建自动递增补丁版本"}；分析 ${result.analytics.enabled ? result.analytics.projectID : "关闭"}；APNs ${result.apns}`,
    );
    const input = hash(
      JSON.stringify({
        versionPolicy: "auto-patch-v1",
        snapshot,
        settings,
        toolchain: report.toolchain,
      }),
    );
    const artifactPath = resolve(buildRoot, "artifact.json");
    const appPath = resolve(
      buildRoot,
      `Build/Products/${options.configuration}-iphoneos/RunweaveNative.app`,
    );
    let cached = null,
      product;
    if (existsSync(artifactPath)) {
      try {
        cached = readJSON(artifactPath);
        buildNumber(cached.buildNumber);
        if (!validVersion(cached.version)) cached = null;
      } catch {
        cached = null;
      }
    }
    if (
      cached?.input === input &&
      compareVersions(cached.version, baseVersion) >= 0 &&
      (!result.before.version ||
        compareVersions(cached.version, result.before.version) >= 0) &&
      (!options.version || cached.version === options.version) &&
      buildNumber(cached.buildNumber) >= minimum &&
      existsSync(appPath)
    ) {
      try {
        product = await inspect(appPath);
        if (
          product.productSHA256 !== cached.productSHA256 ||
          product.version !== cached.version ||
          product.buildNumber !== cached.buildNumber ||
          product.identity.inputsSHA256 !== snapshot.inputsSHA256 ||
          product.identity.sourceRevision !== snapshot.sourceRevision
        )
          product = null;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        product = null;
      }
    }
    phase = "building";
    let version;
    if (!product) {
      const allocated = allocateVersion({
        minimumBuild: minimum,
        baseVersion,
        installedVersion: result.before.version,
        requestedVersion: options.version,
        runId,
      });
      version = allocated.version;
      const number = allocated.buildNumber;
      result.buildNumber = number;
      result.version = version;
      result.build = "building";
      progress(`构建 ${version}；构建号 ${number}；日志 ${dir}/build.log`);
      await checked(
        "xcodebuild",
        [
          ...flags,
          `MARKETING_VERSION=${version}`,
          `CURRENT_PROJECT_VERSION=${number}`,
          "-allowProvisioningUpdates",
          "build",
        ],
        "build",
        1200000,
        4,
      );
      product = await inspect(appPath);
      if (
        product.version !== version ||
        product.buildNumber !== number ||
        product.identity.appVersion !== version ||
        product.identity.appBuild !== number ||
        product.identity.configuration !== options.configuration ||
        product.identity.platform !== "iphoneos" ||
        product.identity.inputsSHA256 !== snapshot.inputsSHA256 ||
        product.identity.sourceRevision !== snapshot.sourceRevision
      )
        fail(
          "artifact_identity_mismatch",
          "Rebuild stable sources; do not install this artifact",
          4,
        );
      writeJSON(artifactPath, {
        input,
        version,
        buildNumber: number,
        productSHA256: product.productSHA256,
      });
      result.build = "built";
    } else {
      version = product.version;
      result.build = "reused";
      progress(`复用 ${product.version}`);
    }
    const afterSource = await source();
    if (JSON.stringify(snapshot) !== JSON.stringify(afterSource))
      fail("source_changed", "Retry with stable sources", 4);
    Object.assign(result, {
      apns: product.apnsEnvironment,
      version,
      appPath,
      buildNumber: product.buildNumber,
      buildId: product.identity.buildId,
      sourceRevision: product.identity.sourceRevision,
      sourceState: product.identity.sourceState,
      inputsSHA256: product.identity.inputsSHA256,
      productSHA256: product.productSHA256,
    });
    await installAndLaunch({
      options,
      result,
      product,
      appPath,
      settings,
      report,
      dir,
      deviceLock,
      waitForUnlock,
      preflight,
      checked,
      fail,
      setPhase: (value) => { phase = value; },
      inspect,
      source,
      sourceSnapshot: snapshot,
      identityCLI,
      aborted: () => controller.signal.aborted,
      progress,
    });
    phase = "saving";
    result.state = "updated";
  } catch (error) {
    result.state = "blocked";
    result.exitCode =
      error.exitCode ||
      ({ building: 4, planning: 4, installing: 5, launching: 6 }[phase] ?? 3);
    result.error = {
      phase: error.phase || phase,
      reason: error.reason || "update_failed",
      message: error.message,
      evidencePath: dryRun ? null : error.evidencePath || dir,
    };
    result.nextAction =
      error.nextAction ||
      `Inspect ${dryRun ? "the preflight result" : dir} and retry after resolving the error`;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (deviceLock) {
      result.lockReleased = deviceLock.release();
      if (!result.lockReleased) {
        result.state = "blocked";
        result.exitCode ||= 3;
        result.nextAction =
          "Owned child processes may still be running; inspect the retained device lock";
      }
    }
    if (releaseBuildLock && (!deviceLock || result.lockReleased))
      releaseBuildLock();
    if (result.state === "updated" && controller.signal.aborted) {
      result.state = "blocked";
      result.exitCode = 3;
      result.nextAction =
        "Update interrupted; inspect the install and launch receipts before retrying";
    }
    if (result.state === "updated" && options["save-target"]) {
      saveTarget(options);
      result.targetSaved = true;
    }
    if (result.state === "updated")
      progress(`完成：${result.version}，PID ${result.pid}`);
    if (dryRun) rmSync(dir, { recursive: true });
    else {
      writeJSON(resolve(dir, "result.json"), result);
      if (result.state === "updated")
        writeJSON(
          resolve(repository, ".runweave/ios-updates/last-success.json"),
          result,
        );
    }
  }
  return result;
}
