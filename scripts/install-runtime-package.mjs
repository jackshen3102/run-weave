import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const artifactsRoot = path.join(repoRoot, ".runtime-artifacts");
const runtimeApiVersion = 1;
const currentShellVersion = JSON.parse(
  readFileSync(path.join(repoRoot, "electron", "package.json"), "utf8"),
).version;
const currentSharedProtocolVersion = JSON.parse(
  readFileSync(
    path.join(repoRoot, "packages", "shared", "package.json"),
    "utf8",
  ),
).version;
const defaultInstalledAppPath = "/Applications/Runweave.app";

function parseArgs(argv) {
  const result = {
    input: null,
    latest: false,
    runtimeHome: null,
    shellVersion: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--latest") {
      result.latest = true;
      continue;
    }
    if (arg === "--runtime-home") {
      result.runtimeHome = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--runtime-home=")) {
      result.runtimeHome = arg.slice("--runtime-home=".length);
      continue;
    }
    if (arg === "--shell-version") {
      result.shellVersion = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--shell-version=")) {
      result.shellVersion = arg.slice("--shell-version=".length);
      continue;
    }
    if (!arg.startsWith("--") && !result.input) {
      result.input = arg;
    }
  }

  return result;
}

function resolveDefaultRuntimeHome() {
  const home = os.homedir();
  if (!home) {
    throw new Error("Cannot resolve user home directory for runtime install");
  }

  return path.join(
    home,
    "Library",
    "Application Support",
    "@runweave",
    "electron",
    "runtime",
  );
}

function isSafeRelativePath(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return false;
  }

  const segments = trimmed.split(/[\\/]+/);
  return segments.every(
    (segment) => segment && segment !== "." && segment !== "..",
  );
}

function resolveInside(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  const base = path.resolve(baseDir);
  if (resolved !== base && resolved.startsWith(`${base}${path.sep}`)) {
    return resolved;
  }
  throw new Error(`Path escapes runtime package: ${relativePath}`);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseVersion(value) {
  return value
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isVersionGreaterThan(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) {
      return true;
    }
    if (leftPart < rightPart) {
      return false;
    }
  }

  return false;
}

function isSameVersion(left, right) {
  return !isVersionGreaterThan(left, right) && !isVersionGreaterThan(right, left);
}

function readInstalledMacAppVersion(appPath = defaultInstalledAppPath) {
  if (process.platform !== "darwin" || !existsSync(appPath)) {
    return null;
  }

  const result = spawnSync(
    "plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ],
    {
      stdio: "pipe",
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function findLatestPackage() {
  if (!existsSync(artifactsRoot)) {
    throw new Error(".runtime-artifacts does not exist");
  }

  const candidates = readdirSync(artifactsRoot)
    .filter((name) => /^runweave-runtime-.+\.zip$/.test(name))
    .map((name) => path.join(artifactsRoot, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    throw new Error("No runtime zip found in .runtime-artifacts");
  }

  return candidates[0];
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }

  return result.stdout;
}

function assertSafeZipEntries(zipPath) {
  const output = run("unzip", ["-Z1", zipPath]);
  for (const entry of output.split(/\r?\n/).filter(Boolean)) {
    const normalizedEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (!isSafeRelativePath(normalizedEntry)) {
      throw new Error(`Unsafe zip entry: ${entry}`);
    }
  }
}

function extractZip(zipPath) {
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), "runweave-runtime-install-"),
  );
  assertSafeZipEntries(zipPath);
  run("unzip", ["-q", zipPath, "-d", tempDir]);
  return tempDir;
}

function resolvePackageRoot(inputPath) {
  const stat = statSync(inputPath);
  if (stat.isDirectory()) {
    return {
      packageRoot: path.resolve(inputPath),
      cleanup: () => {},
    };
  }

  const extractedDir = extractZip(inputPath);
  return {
    packageRoot: extractedDir,
    cleanup: () => {
      rmSync(extractedDir, { recursive: true, force: true });
    },
  };
}

function readManifest(packageRoot) {
  const manifestPath = path.join(packageRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Runtime package is missing manifest.json: ${packageRoot}`);
  }

  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function validateManifest(packageRoot, manifest, targetShellVersion) {
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported runtime manifest schemaVersion");
  }
  if (manifest.runtimeApiVersion !== runtimeApiVersion) {
    throw new Error("Unsupported runtimeApiVersion");
  }
  if (
    typeof manifest.minimumShellVersion !== "string" ||
    !manifest.minimumShellVersion.trim()
  ) {
    throw new Error("Runtime package is missing a shell version requirement");
  }
  if (!isSameVersion(manifest.minimumShellVersion, targetShellVersion)) {
    throw new Error(
      `Runtime package targets shell version ${manifest.minimumShellVersion}, but the installed shell version is ${targetShellVersion}. Install the matching Runweave app before installing this runtime package.`,
    );
  }
  if (manifest.sharedProtocolVersion !== currentSharedProtocolVersion) {
    throw new Error("Runtime package shared protocol version is incompatible");
  }
  if (
    !isSafeRelativePath(manifest.releaseId) ||
    manifest.releaseId.includes("/")
  ) {
    throw new Error("Invalid runtime releaseId");
  }
  if (
    !isSafeRelativePath(manifest.frontend?.distDir) ||
    !isSafeRelativePath(manifest.frontend?.index) ||
    !isSafeRelativePath(manifest.backend?.entry)
  ) {
    throw new Error("Runtime manifest contains invalid frontend/backend paths");
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error("Runtime manifest files must be an array");
  }

  const requiredPaths = [
    manifest.frontend.index,
    manifest.backend.entry,
    ...manifest.files.map((file) => file.path),
  ];

  for (const relativePath of requiredPaths) {
    if (!isSafeRelativePath(relativePath)) {
      throw new Error(`Invalid runtime file path: ${relativePath}`);
    }
    const fullPath = resolveInside(packageRoot, relativePath);
    if (!existsSync(fullPath)) {
      throw new Error(`Runtime package is missing file: ${relativePath}`);
    }
  }

  for (const file of manifest.files) {
    if (
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      throw new Error(`Invalid sha256 for runtime file: ${file.path}`);
    }
    const fullPath = resolveInside(packageRoot, file.path);
    const actual = sha256(fullPath);
    if (actual !== file.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch for runtime file: ${file.path}`);
    }
  }
}

function installPackage(packageRoot, runtimeHome, manifest) {
  const releasesDir = path.join(runtimeHome, "releases");
  const finalReleaseDir = path.join(releasesDir, manifest.releaseId);
  const tempReleaseDir = path.join(releasesDir, `${manifest.releaseId}.tmp`);

  mkdirSync(releasesDir, { recursive: true });
  if (existsSync(finalReleaseDir)) {
    throw new Error(`Runtime release already exists: ${finalReleaseDir}`);
  }

  rmSync(tempReleaseDir, { recursive: true, force: true });
  cpSync(packageRoot, tempReleaseDir, { recursive: true });
  renameSync(tempReleaseDir, finalReleaseDir);

  const currentJson = path.join(runtimeHome, "current.json");
  const currentTemp = `${currentJson}.tmp`;
  writeFileSync(
    currentTemp,
    `${JSON.stringify(
      {
        releaseId: manifest.releaseId,
        activatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  renameSync(currentTemp, currentJson);
}

const args = parseArgs(process.argv.slice(2));
const input = args.latest ? findLatestPackage() : args.input;
if (!input) {
  throw new Error(
    "Usage: node scripts/install-runtime-package.mjs <zip|dir> [--runtime-home <path>] [--shell-version <version>] [--latest]",
  );
}

const runtimeHome =
  args.runtimeHome ??
  process.env.RUNWEAVE_RUNTIME_HOME ??
  resolveDefaultRuntimeHome();
const targetShellVersion =
  args.shellVersion ??
  process.env.RUNWEAVE_SHELL_VERSION ??
  readInstalledMacAppVersion() ??
  currentShellVersion;
const resolvedPackage = resolvePackageRoot(path.resolve(input));
try {
  const manifest = readManifest(resolvedPackage.packageRoot);
  validateManifest(resolvedPackage.packageRoot, manifest, targetShellVersion);
  installPackage(
    resolvedPackage.packageRoot,
    path.resolve(runtimeHome),
    manifest,
  );

  console.log(`[runtime] installed release: ${manifest.releaseId}`);
  console.log(`[runtime] runtime home: ${path.resolve(runtimeHome)}`);
} finally {
  resolvedPackage.cleanup();
}
