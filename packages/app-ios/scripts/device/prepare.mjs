import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  bundleID,
  command,
  DeviceError,
  hash,
  pkg,
  project,
  readJSON,
  root,
  treeDigest,
  writeJSON,
} from "./support.mjs";

export function loadSuite(path) {
  let dir, manifest, source;
  try {
    dir = realpathSync(path);
    manifest = readJSON(resolve(dir, "suite.json"));
    source = readFileSync(resolve(dir, "Suite.swift"), "utf8");
  } catch {
    throw new DeviceError(
      "invalid_suite",
      "arguments",
      "Provide a suite directory containing suite.json and Suite.swift",
      2,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.bundleID !== bundleID ||
    !Array.isArray(manifest.cases) ||
    !manifest.cases.length ||
    manifest.cases.length > 20 ||
    new Set(manifest.cases).size !== manifest.cases.length ||
    manifest.cases.some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id),
    ) ||
    (manifest.launchArguments !== undefined &&
      (!Array.isArray(manifest.launchArguments) ||
        manifest.launchArguments.some((arg) => typeof arg !== "string"))) ||
    (manifest.timeoutSeconds !== undefined &&
      (!Number.isInteger(manifest.timeoutSeconds) ||
        manifest.timeoutSeconds < 30 ||
        manifest.timeoutSeconds > 1800))
  ) {
    throw new DeviceError(
      "invalid_suite",
      "arguments",
      "Use schemaVersion 1, the Runweave bundle ID, 1–20 unique case IDs and a 30–1800 s timeout",
      2,
    );
  }
  return {
    dir,
    manifest,
    source,
    digest: hash(JSON.stringify(manifest) + "\0" + source),
  };
}
async function required(program, args, ctx, name, timeout = 600000) {
  const result = await command(program, args, {
    dir: ctx.dir,
    name,
    timeout,
    owner: ctx.lock,
  });
  if (
    !result.ok &&
    /No profiles for|requires a development team|No signing certificate|No Accounts|provisioning profile.*(?:expired|doesn't include)/i.test(
      result.output,
    )
  ) {
    throw new DeviceError(
      "signing_unavailable",
      "preparing",
      "Resolve the reported signing identity or provisioning profile in Xcode",
      3,
      result.evidencePath,
    );
  }
  if (!result.ok)
    throw new DeviceError(
      "artifact_unverified",
      "preparing",
      `Inspect ${name}.log; resolve build/signing errors before retrying`,
      5,
      result.evidencePath,
    );
  return result.output;
}
async function artifact(path, ctx, name) {
  if (!existsSync(path)) return null;
  const result = await command(
    "codesign",
    ["--verify", "--deep", "--strict", path],
    { dir: ctx.dir, name: `${name}-verify`, owner: ctx.lock },
  );
  if (!result.ok) return null;
  const info = await command("codesign", ["-dv", "--verbose=4", path], {
    dir: ctx.dir,
    name: `${name}-identity`,
    owner: ctx.lock,
  });
  if (!info.ok || !info.output.includes(`TeamIdentifier=${ctx.report.team}\n`))
    return null;
  return treeDigest([path]).digest;
}
function appInputs(dependencies) {
  const paths = [
    resolve(pkg, "Package.swift"),
    resolve(pkg, "Package.resolved"),
    resolve(pkg, "Sources"),
    resolve(pkg, "ios"),
    resolve(dependencies, "checkouts"),
    resolve(dependencies, "workspace-state.json"),
  ];
  const result = treeDigest(paths);
  const manifests = existsSync(resolve(dependencies, "checkouts"))
    ? readdirSync(resolve(dependencies, "checkouts"))
        .map((entry) =>
          resolve(dependencies, "checkouts", entry, "Package.swift"),
        )
        .filter(existsSync)
    : [];
  const projectText = readFileSync(resolve(project, "project.pbxproj"), "utf8");
  const reasons = [];
  if (result.symlinks) reasons.push("external_symlink_input");
  if (!manifests.length) reasons.push("dependencies_not_resolved");
  if (
    /PBXShellScriptBuildPhase/.test(projectText) ||
    manifests.some((file) => /\.plugin\s*\(/.test(readFileSync(file, "utf8")))
  )
    reasons.push("generated_plugin_or_script_inputs_require_xcode");
  // New external package paths must be described before enabling App cache reuse.
  if (
    /\.package\s*\(\s*path\s*:/.test(
      readFileSync(resolve(pkg, "Package.swift"), "utf8"),
    )
  )
    reasons.push("unmodelled_local_dependency");
  return { ...result, reasons };
}
export async function prepare(ctx) {
  const { options, report, suite } = ctx;
  const identity = {
    worktree: realpathSync(pkg),
    device: options.device,
    configuration: options.configuration,
    toolchain: report.toolchain,
    team: report.team,
    signing: readFileSync(resolve(ctx.dir, "preflight/signing.log"), "utf8"),
    environment: hash(
      JSON.stringify(
        Object.entries(process.env)
          .filter(([key]) =>
            /^(DEVELOPER_DIR|SDKROOT|TOOLCHAINS|PATH|XCODE_XCCONFIG_FILE|SWIFT.*|CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS)$/.test(
              key,
            ),
          )
          .sort(),
      ),
    ),
  };
  // Stable per-worktree/toolchain/configuration slots preserve Xcode's incremental graph.
  const slot = resolve(
    root,
    "cache",
    hash(JSON.stringify({ ...identity, environment: undefined })).slice(0, 24),
  );
  mkdirSync(slot, { recursive: true });
  const dependencies = resolve(slot, "SourcePackages");
  const appDD = resolve(slot, "app");
  const appFlags = [
    "-project",
    project,
    "-scheme",
    "RunweaveNative",
    "-configuration",
    options.configuration,
    "-destination",
    `platform=iOS,id=${options.device}`,
    "-derivedDataPath",
    appDD,
    "-clonedSourcePackagesDirPath",
    dependencies,
    "-packageCachePath",
    resolve(slot, "PackageCache"),
    `DEVELOPMENT_TEAM=${report.team}`,
  ];
  const settings = await required(
    "xcodebuild",
    [...appFlags, "-showBuildSettings", "-json"],
    ctx,
    "app-settings",
    120000,
  );
  const before = appInputs(dependencies);
  const input = hash(JSON.stringify(identity) + settings + before.digest);
  const app = resolve(
    appDD,
    `Build/Products/${options.configuration}-iphoneos/RunweaveNative.app`,
  );
  const receiptPath = resolve(slot, "app-receipt.json");
  let receipt;
  try {
    receipt = readJSON(receiptPath);
  } catch {
    /* No trusted receipt. */
  }
  let content = await artifact(app, ctx, "app");
  const reuse =
    before.reasons.length === 0 &&
    receipt?.input === input &&
    receipt?.content === content &&
    content;
  ctx.event("app_preparation", {
    action: reuse ? "reuse" : "build",
    reasons: reuse
      ? ["verified_inputs_and_signed_content"]
      : [
          ...before.reasons,
          receipt?.input !== input
            ? "inputs_changed_or_missing"
            : "artifact_unverified",
        ],
    input,
  });
  if (!reuse) {
    ctx.data.counts.appBuild += 1;
    ctx.save();
    await required(
      "xcodebuild",
      [...appFlags, "-allowProvisioningUpdates", "build"],
      ctx,
      "app-build",
    );
    content = await artifact(app, ctx, "app-built");
    if (!content)
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Inspect the signed App product",
        5,
        app,
      );
    // Do not sign off an input that changed while Xcode was building.
    const after = appInputs(dependencies);
    if (before.digest !== after.digest)
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Build inputs changed while building; retry against stable sources",
        5,
        app,
      );
    writeJSON(receiptPath, { input, content, app, reasons: after.reasons });
  }
  const plist = await required(
    "plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      resolve(app, "Info.plist"),
    ],
    ctx,
    "app-bundle",
    10000,
  );
  if (plist.trim() !== bundleID)
    throw new DeviceError(
      "artifact_unverified",
      "preparing",
      "App Bundle ID does not match the fixed target",
      5,
      app,
    );
  ctx.data.app = { input, content, path: app, reuse: Boolean(reuse) };
  ctx.save();

  const template = resolve(pkg, "scripts/device/runner");
  const runnerInput = hash(
    JSON.stringify(identity) +
      options.runnerBundleID +
      treeDigest([template, resolve(pkg, "scripts/device/prepare.mjs")])
        .digest +
      suite.digest,
  );
  const runnerDir = resolve(slot, "runners", runnerInput);
  const runnerDD = resolve(runnerDir, "DerivedData");
  const runnerFlags = [
    "-project",
    resolve(runnerDir, "DeviceRunner.xcodeproj"),
    "-scheme",
    "DeviceRunner",
    "-configuration",
    options.configuration,
    "-destination",
    `platform=iOS,id=${options.device}`,
    "-derivedDataPath",
    runnerDD,
    `DEVELOPMENT_TEAM=${report.team}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${options.runnerBundleID}`,
  ];
  const runnerSettings = async () =>
    hash(
      await required(
        "xcodebuild",
        [...runnerFlags, "build-for-testing", "-showBuildSettings", "-json"],
        ctx,
        "runner-settings",
        30000,
      ),
    );
  const runner = resolve(
    runnerDD,
    `Build/Products/${options.configuration}-iphoneos/DeviceRunner-Runner.app`,
  );
  const runnerReceiptPath = resolve(runnerDir, "receipt.json");
  let runnerReceipt;
  try {
    runnerReceipt = readJSON(runnerReceiptPath);
  } catch {
    /* Build on first use. */
  }
  let runnerContent = await artifact(runner, ctx, "runner");
  let xctestrun = runnerReceipt?.xctestrun;
  let verified =
    runnerContent &&
    runnerReceipt?.content === runnerContent &&
    xctestrun &&
    existsSync(xctestrun) &&
    runnerReceipt?.xctestrunDigest === hash(readFileSync(xctestrun));
  if (verified) verified = await validateTestRun(xctestrun, runnerDD, ctx);
  if (verified) verified = runnerReceipt.settings === (await runnerSettings());
  ctx.event("runner_preparation", {
    action: verified ? "reuse" : "build",
    reason: verified
      ? "verified_inputs_and_signed_content"
      : "inputs_changed_or_artifact_unverified",
    input: runnerInput,
  });
  if (!verified) {
    mkdirSync(runnerDir, { recursive: true });
    cpSync(template, runnerDir, { recursive: true });
    writeFileSync(resolve(runnerDir, "Suite.swift"), suite.source);
    const literals = (values) =>
      values
        .map(
          (value) =>
            `String(data: Data(base64Encoded: "${Buffer.from(value).toString("base64")}")!, encoding: .utf8)!`,
        )
        .join(", ");
    writeFileSync(
      resolve(runnerDir, "Selection.swift"),
      `import Foundation\nenum Selection { static let ids: [String] = [${literals(suite.manifest.cases)}]; static let launchArguments: [String] = [${literals(suite.manifest.launchArguments || [])}] }\n`,
    );
    ctx.data.counts.runnerBuild += 1;
    ctx.save();
    await required(
      "xcodebuild",
      [...runnerFlags, "-allowProvisioningUpdates", "build-for-testing"],
      ctx,
      "runner-build",
    );
    const products = resolve(runnerDD, "Build/Products");
    const candidates = readdirSync(products).filter((file) =>
      file.endsWith(".xctestrun"),
    );
    if (candidates.length !== 1)
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Expected exactly one runner xctestrun",
        5,
        products,
      );
    xctestrun = resolve(products, candidates[0]);
    runnerContent = await artifact(runner, ctx, "runner-built");
    if (!runnerContent || !(await validateTestRun(xctestrun, runnerDD, ctx)))
      throw new DeviceError(
        "artifact_unverified",
        "preparing",
        "Runner signature or xctestrun references are invalid",
        5,
        runnerDir,
      );
    writeJSON(runnerReceiptPath, {
      settings: await runnerSettings(),
      input: runnerInput,
      content: runnerContent,
      xctestrun,
      xctestrunDigest: hash(readFileSync(xctestrun)),
    });
  }
  ctx.data.runner = {
    bundleID: options.runnerBundleID + ".xctrunner",
    input: runnerInput,
    content: runnerContent,
    xctestrun,
    reuse: Boolean(verified),
  };
  ctx.save();
  return {
    app,
    xctestrun,
    runnerDD,
    unchanged: () =>
      appInputs(dependencies).digest === before.digest &&
      treeDigest([app]).digest === content &&
      treeDigest([runner]).digest === runnerContent,
  };
}
async function validateTestRun(file, derivedData, ctx) {
  const result = await command(
    "plutil",
    ["-convert", "json", "-o", "-", file],
    { dir: ctx.dir, name: "xctestrun-verify", owner: ctx.lock },
  );
  if (!result.ok) return false;
  const config = JSON.parse(result.output);
  const targets =
    config.TestConfigurations?.flatMap((entry) => entry.TestTargets || []) ||
    Object.entries(config)
      .filter(([key]) => key !== "__xctestrun_metadata__")
      .map(([, value]) => value);
  if (targets.length !== 1) return false;
  const target = targets[0];
  for (const key of ["TestBundlePath", "TestHostPath"]) {
    if (typeof target[key] !== "string") return false;
    const path = target[key]
      .replaceAll("__TESTROOT__", resolve(derivedData, "Build/Products"))
      .replaceAll(
        "__TESTHOST__",
        target.TestHostPath.replaceAll(
          "__TESTROOT__",
          resolve(derivedData, "Build/Products"),
        ),
      );
    if (!path.startsWith(derivedData + "/") || !existsSync(path)) return false;
  }
  return true;
}
