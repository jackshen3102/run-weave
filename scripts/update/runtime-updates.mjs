import { explicitConfigurationArguments, configurationLibrary } from "../lib/configuration.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { commandName } from "./core.mjs";
import { readJsonFile, runChecked, runCaptureChecked } from "./system.mjs";

export async function runResearchMcpUpdate({ sourceRoot, sourceGuard }) {
  const installation = configurationLibrary.readResearchMcpInstallation();
  if (!installation) return { action: "skip", reason: "not installed" };
  await sourceGuard.check("before Research MCP update");
  await runChecked(process.execPath, ["./scripts/install/research-mcp.mjs", ...explicitConfigurationArguments()], { cwd: sourceRoot });
  await sourceGuard.check("after Research MCP update");
  return { action: "update", releaseId: configurationLibrary.readResearchMcpInstallation()?.releaseId };
}

export async function runRuntimeUpdate({
  channel,
  gitHead,
  installedAppVersion,
  runtimeHome,
  sourceRoot,
  sourceGuard,
}) {
  await sourceGuard.check("before Runtime build");
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
  await sourceGuard.check("before Runtime install");
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
  await sourceGuard.check("after Runtime update");
  return manifest;
}

export async function runAppServerUpdate({
  appServerHome,
  controlCliPath,
  gitHead,
  sourceRoot,
  sourceGuard,
}) {
  await sourceGuard.check("before App Server update");
  const instanceKey = path.basename(path.resolve(appServerHome));
  const releaseId = `local-app-server-${instanceKey}-${Date.now()}`;
  const cliEntry =
    controlCliPath ??
    path.join(sourceRoot, "packages", "runweave-cli", "dist", "index.js");

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
  await sourceGuard.check("before App Server restart");
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
    {
      cwd: sourceRoot,
      env: { ...process.env, RUNWEAVE_SOURCE_REVISION: gitHead ?? "unknown" },
    },
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
