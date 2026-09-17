import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCapture, runCaptureChecked, runChecked } from "./system.mjs";

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

async function checkCommand(commandPath, expectedEntry) {
  if (!commandPath) return;
  const installedEntry = await fs.realpath(expectedEntry).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!installedEntry || (await fs.realpath(commandPath)) !== installedEntry) {
    throw new Error(
      `rw resolves to ${commandPath}, outside the active npm global package ${expectedEntry}. Align the shell PATH and npm prefix before updating.`,
    );
  }
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
  const commandPath = await resolveCommand(sourceRoot);
  await checkCommand(commandPath, entry);
  return {
    action: "sync",
    reason:
      "Build the current CLI and install the global package when its content differs.",
    prefix,
    commandPath,
    entry,
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

export async function runCliUpdate({ sourceRoot, plan }) {
  if (plan.action === "skip") return plan;
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
  const needsInstall =
    !current.commandPath || (await sha256(plan.entry)) !== expectedHash;
  if (needsInstall) {
    await runChecked(
      process.execPath,
      ["scripts/release/publish-cli-local.mjs"],
      { cwd: sourceRoot, env },
    );
  }
  const commandPath = await resolveCommand(sourceRoot);
  if (!commandPath)
    throw new Error(
      "Global CLI installed but rw is not on the login shell PATH.",
    );
  await checkCommand(commandPath, plan.entry);
  if ((await sha256(commandPath)) !== expectedHash) {
    throw new Error("The rw command does not match the current CLI build.");
  }
  const version = (
    await runCaptureChecked(commandPath, ["--version"], { cwd: sourceRoot })
  ).stdout.trim();
  return {
    ...plan,
    action: needsInstall ? "updated" : "unchanged",
    commandPath,
    sha256: expectedHash,
    version,
  };
}
