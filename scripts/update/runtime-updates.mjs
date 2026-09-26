import { explicitConfigurationArguments } from "../lib/configuration.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { commandName } from "./core.mjs";
import { readJsonFile, runChecked, runCaptureChecked } from "./system.mjs";

export async function runRuntimeUpdate({
  channel,
  gitHead,
  installedAppVersion,
  runtimeHome,
  sourceRoot,
}) {
  const releaseId = `local-${Date.now()}`;
  const shellVersionArg = installedAppVersion
    ? [`--shell-version=${installedAppVersion}`]
    : [];

  const artifactsRoot = path.resolve(
    process.env.RUNWEAVE_RUNTIME_ARTIFACTS_ROOT ??
      path.join(sourceRoot, ".runtime-artifacts"),
  );
  const runtimeZipPath = path.join(
    artifactsRoot,
    `runweave-runtime-${releaseId}.zip`,
  );
  const runtimeManifestPath = path.join(
    artifactsRoot,
    releaseId,
    "manifest.json",
  );
  await runChecked(
    commandName("pnpm"),
    ["runtime:build", "--", `--release-id=${releaseId}`, ...shellVersionArg],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        VITE_RUNWEAVE_CHANNEL: channel,
        VITE_RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown",
        VITE_RUNWEAVE_VERSION: installedAppVersion ?? "unknown",
      },
    },
  );
  await runChecked(
    commandName("pnpm"),
    [
      "runtime:install",
      "--",
      runtimeZipPath,
      ...explicitConfigurationArguments(),
      `--runtime-home=${runtimeHome}`,
      ...shellVersionArg,
    ],
    { cwd: sourceRoot },
  );

  const manifest = readJsonFile(runtimeManifestPath);
  if (manifest?.releaseId !== releaseId) {
    throw new Error(
      `runtime manifest identity mismatch: expected ${releaseId}`,
    );
  }
  return manifest;
}

export async function runAppServerUpdate({
  appServerHome,
  controlCliPath,
  sourceRoot,
}) {
  const instanceKey = path.basename(path.resolve(appServerHome));
  const releaseId = `local-app-server-${instanceKey}-${Date.now()}`;
  const cliEntry =
    controlCliPath ??
    path.join(
      sourceRoot,
      "packages",
      "runweave-cli",
      "dist",
      "index.js",
    );

  await runChecked(
    "node",
    [
      "./scripts/install/app-server.mjs",
      `--release-id=${releaseId}`,
      `--home=${appServerHome}`,
      ...explicitConfigurationArguments(),
    ],
    { cwd: sourceRoot },
  );
  await fs.access(cliEntry);

  const restart = await runCaptureChecked(
    "node",
    [
      cliEntry,
      "app-server",
      "restart",
      "--home",
      appServerHome,
      ...explicitConfigurationArguments(),
    ],
    { cwd: sourceRoot },
  );

  let status = null;
  try {
    status = JSON.parse(restart.stdout);
  } catch {
    status = null;
  }

  return {
    home: appServerHome,
    releaseId,
    status,
  };
}
