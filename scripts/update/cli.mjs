import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCapture, runCaptureChecked, runChecked } from "./system.mjs";
import {
  installCliArtifact,
  withCliReleaseLock,
} from "../release/cli-artifact.mjs";

async function resolveCommand(sourceRoot) {
  const result = await runCapture(
    process.env.SHELL || "/bin/sh",
    ["-lc", "command -v rw"],
    { cwd: sourceRoot },
  );
  if (!result.ok && result.code === 1 && !result.stderr.trim()) return null;
  const commandPath = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!result.ok || !path.isAbsolute(commandPath ?? "")) {
    throw new Error(
      "Cannot resolve the login shell's rw command; check its PATH and aliases.",
    );
  }
  return commandPath;
}

async function realpathOrNull(file) {
  return fs.realpath(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function checkCommand(commandPath, expectedEntry, allowMissing = false) {
  const commandEntry = await realpathOrNull(commandPath);
  if (!commandEntry && allowMissing) return;
  const installedEntry = await realpathOrNull(expectedEntry);
  if (!installedEntry || commandEntry !== installedEntry) {
    throw new Error(
      `rw resolves to ${commandPath}, outside the active npm global package ${expectedEntry}. Align the shell PATH and npm prefix before updating.`,
    );
  }
}

async function inspectShellCommand(sourceRoot, expectedEntry) {
  const commandPath = await resolveCommand(sourceRoot);
  if (!commandPath) return null;
  const installedEntry = await realpathOrNull(expectedEntry);
  if (installedEntry && (await realpathOrNull(commandPath)) === installedEntry)
    return { kind: "global", commandPath };

  // Backend-generated wrappers deliberately precede npm on a Runweave terminal's
  // PATH. Read their binding without executing it or changing the caller's PATH.
  const runner = path.join(path.dirname(commandPath), "bound-cli.cjs");
  const source = await fs.readFile(runner, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const serialized = source.match(/^const binding=(\{.*\});$/m)?.[1];
  const binding = serialized ? JSON.parse(serialized) : null;
  if (
    binding &&
    ["stable", "dev"].includes(binding.kind) &&
    typeof binding.instanceId === "string" &&
    typeof binding.configRoot === "string" &&
    path.isAbsolute(binding.configRoot) &&
    commandPath === path.join(binding.configRoot, "runtime", "bin", "rw") &&
    typeof binding.digest === "string" &&
    typeof binding.entry === "string" &&
    binding.entry.startsWith(path.join(binding.configRoot, "runtime", "cli") + path.sep) &&
    (await sha256(binding.entry)) === binding.digest
  ) {
    const wrapper = await fs.readFile(commandPath, "utf8");
    const quotedRunner = `'${runner.replace(/'/g, `'\\''`)}'`;
    if (
      wrapper.startsWith("#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ") &&
      wrapper.endsWith(` ${quotedRunner} "$@"\n`)
    )
      return {
        kind: "instance",
        commandPath,
        instanceId: binding.instanceId,
        configRoot: binding.configRoot,
      };
  }
  await checkCommand(commandPath, expectedEntry);
}

/** Inspect without building or installing, including during --dry-run. */
export async function planCliUpdate({ sourceRoot, channel }) {
  if (channel !== "stable") {
    return {
      action: "skip",
      reason: "Beta updates do not replace the global Stable CLI.",
    };
  }
  const prefix = (
    await runCaptureChecked("npm", ["prefix", "-g"], { cwd: sourceRoot })
  ).stdout.trim();
  const entry = path.join(
    prefix,
    "lib",
    "node_modules",
    "@runweave",
    "cli",
    "dist",
    "index.js",
  );
  const commandPath = path.join(prefix, "bin", "rw");
  await checkCommand(commandPath, entry, true);
  const shellCommand = await inspectShellCommand(sourceRoot, entry);
  return {
    action: "sync",
    reason:
      "Build the current CLI and install the global package when its content differs.",
    prefix,
    commandPath,
    entry,
    shellCommand,
  };
}

async function sha256(file) {
  try {
    return createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function nativeRuntimeHash(entry) {
  const root = path.join(
    path.dirname(entry),
    "node_modules",
    "fs-native-extensions",
  );
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else
        hash.update(path.relative(root, file)).update(await fs.readFile(file));
    }
  }
  try {
    await visit(root);
    return hash.digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function runCliUpdate({ sourceRoot, plan }) {
  if (plan.action === "skip") return plan;
  return withCliReleaseLock(plan.prefix, () =>
    updateLockedCli({ sourceRoot, plan }),
  );
}

async function updateLockedCli({ sourceRoot, plan }) {
  const env = { ...process.env };
  delete env.RUNWEAVE_CLI_BUNDLE_OUTFILE;
  await runChecked("pnpm", ["cli:build"], { cwd: sourceRoot, env });
  const sourceEntry = path.join(
    sourceRoot,
    "packages",
    "runweave-cli",
    "dist",
    "index.js",
  );
  const expectedHash = await sha256(sourceEntry);
  if (!expectedHash) throw new Error("CLI build did not produce dist/index.js");
  const expectedNativeHash = await nativeRuntimeHash(sourceEntry);
  if (!expectedNativeHash)
    throw new Error("CLI build did not include the native lock runtime");
  // Recheck the target before mutation; another npm prefix must not be updated by accident.
  const current = await planCliUpdate({ sourceRoot, channel: "stable" });
  if (
    current.prefix !== plan.prefix ||
    current.commandPath !== plan.commandPath
  ) {
    throw new Error(
      "Global CLI target changed during the desktop update; rerun the plan.",
    );
  }
  const release = await installCliArtifact({ sourceRoot, plan });
  const commandPath = plan.commandPath;
  await checkCommand(commandPath, plan.entry);
  const shellCommand = await inspectShellCommand(sourceRoot, plan.entry);
  if (!shellCommand)
    throw new Error("Global CLI installed but rw is not on the login shell PATH.");
  if (
    (await sha256(commandPath)) !== expectedHash ||
    (await nativeRuntimeHash(plan.entry)) !== expectedNativeHash
  ) {
    throw new Error("The rw command does not match the current CLI build.");
  }
  const version = (
    await runCaptureChecked(commandPath, ["--version"], { cwd: sourceRoot })
  ).stdout.trim();
  if (version !== release.version)
    throw new Error("The rw version does not match the installed release.");
  return {
    ...plan,
    ...release,
    commandPath,
    shellCommand,
    sha256: expectedHash,
    nativeRuntimeSha256: expectedNativeHash,
    version,
  };
}
