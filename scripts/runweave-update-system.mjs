import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  filterChangedFilesAgainstSnapshot,
  readDotenvValue,
  RUNWEAVE_CODESIGN_IDENTITY_ENV,
  upsertDotenvValue,
} from "./runweave-update-core.mjs";
import { codesignEnvFileRelativePath } from "./runweave-update-context.mjs";

export function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ ok: code === 0, code: code ?? 1, signal });
    });
  });
}

export function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

export async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}`,
    );
  }
}

export async function runCaptureChecked(command, args, options = {}) {
  const result = await runCapture(command, args, options);
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readPackageVersion(packagePath) {
  return readJsonFile(packagePath)?.version ?? null;
}

export async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readInstalledMacAppVersion(appPath) {
  if (process.platform !== "darwin" || !existsSync(appPath)) {
    return null;
  }

  const result = await runCapture("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);

  if (!result.ok) {
    return null;
  }

  return result.stdout.trim() || null;
}

export async function listCodesignIdentities() {
  if (process.platform !== "darwin") {
    return [];
  }

  const result = await runCapture("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/"([^"]+)"/)?.[1])
    .filter(Boolean);
}

export async function writeCodesignIdentityConfig(
  configPath,
  rawConfig,
  identity,
) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    upsertDotenvValue(
      rawConfig ?? "",
      RUNWEAVE_CODESIGN_IDENTITY_ENV,
      identity,
    ),
  );
}

export async function resolveCodesignIdentity(sourceRoot, options = {}) {
  const explicitIdentity = process.env[RUNWEAVE_CODESIGN_IDENTITY_ENV]?.trim();
  if (explicitIdentity) {
    return {
      identity: explicitIdentity,
      source: "environment",
    };
  }

  const configPath = path.join(sourceRoot, codesignEnvFileRelativePath);
  const persistConfig = options.persistConfig ?? true;
  const rawConfig = await readTextFile(configPath);
  const configuredIdentity = rawConfig
    ? readDotenvValue(rawConfig, RUNWEAVE_CODESIGN_IDENTITY_ENV)?.trim()
    : null;
  const excluded = new Set(options.exclude ?? []);
  const identities = await listCodesignIdentities();

  if (
    configuredIdentity &&
    !excluded.has(configuredIdentity) &&
    identities.includes(configuredIdentity)
  ) {
    return {
      identity: configuredIdentity,
      source: codesignEnvFileRelativePath,
    };
  }

  const nextIdentity = identities.find((identity) => !excluded.has(identity));
  if (!nextIdentity) {
    return {
      identity: null,
      source: configuredIdentity ? "unavailable-config" : "none",
    };
  }

  if (persistConfig) {
    await writeCodesignIdentityConfig(configPath, rawConfig, nextIdentity);
  }
  return {
    identity: nextIdentity,
    source: configuredIdentity
      ? persistConfig
        ? "refreshed-config"
        : "would-refresh-config"
      : persistConfig
        ? "generated-config"
        : "would-generate-config",
  };
}

export async function getGitHead(sourceRoot) {
  const result = await runCapture("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
  });
  return result.ok ? result.stdout.trim() : null;
}

export async function getGitStatusDirty(sourceRoot) {
  const result = await runCapture("git", ["status", "--porcelain"], {
    cwd: sourceRoot,
  });
  return result.ok && result.stdout.trim().length > 0;
}

export async function getGitChangedFilesSinceState(sourceRoot, state) {
  const changed = [];
  if (state?.gitHead) {
    const committed = await runCapture(
      "git",
      ["diff", "--name-only", state.gitHead, "HEAD"],
      { cwd: sourceRoot },
    );
    if (committed.ok) {
      changed.push(...committed.stdout.split(/\r?\n/));
    } else {
      changed.push("electron/src/main.ts");
    }
  }

  const worktreeFiles = [];
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = await runCapture("git", args, { cwd: sourceRoot });
    if (result.ok) {
      worktreeFiles.push(...result.stdout.split(/\r?\n/));
    }
  }
  changed.push(...worktreeFiles, ...Object.keys(state?.worktreeSnapshot ?? {}));
  const candidateFiles = changed.map((file) => file.trim()).filter(Boolean);
  const currentSnapshot = await createFileSnapshot(sourceRoot, candidateFiles);
  return filterChangedFilesAgainstSnapshot({
    candidateFiles,
    currentSnapshot,
    previousSnapshot: state?.worktreeSnapshot,
  });
}

export async function createWorktreeSnapshot(sourceRoot) {
  const files = [];
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = await runCapture("git", args, { cwd: sourceRoot });
    if (result.ok) {
      files.push(...result.stdout.split(/\r?\n/));
    }
  }
  return await createFileSnapshot(
    sourceRoot,
    files.map((file) => file.trim()).filter(Boolean),
  );
}

export async function createFileSnapshot(sourceRoot, filePaths) {
  const snapshot = {};
  for (const filePath of Array.from(new Set(filePaths)).sort()) {
    const absolutePath = path.join(sourceRoot, filePath);
    try {
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        snapshot[filePath] = `link:${await fs.readlink(absolutePath)}`;
        continue;
      }
      if (!stat.isFile()) {
        snapshot[filePath] = `other:${stat.mode & 0o777}`;
        continue;
      }
      const digest = createHash("sha256")
        .update(await fs.readFile(absolutePath))
        .digest("hex");
      snapshot[filePath] = `file:${stat.mode & 0o777}:${digest}`;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      snapshot[filePath] = "missing";
    }
  }
  return snapshot;
}
