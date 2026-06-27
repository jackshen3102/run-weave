import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type RuntimeReleaseSource = "external" | "bundled";

export interface RuntimeRelease {
  source: RuntimeReleaseSource;
  releaseId: string;
  frontendDistDir: string;
  backendEntry: string;
  cliEntry: string;
  appServerEntry: string;
  nodePtyDir: string;
  runtimeRoot: string | null;
  releaseDir: string | null;
}

interface RuntimePointer {
  releaseId?: unknown;
}

interface RuntimeManifest {
  schemaVersion?: unknown;
  releaseId?: unknown;
  frontend?: {
    distDir?: unknown;
    index?: unknown;
  };
  backend?: {
    entry?: unknown;
  };
  cli?: {
    entry?: unknown;
  };
  appServer?: {
    entry?: unknown;
  };
  files?: Array<{
    path?: unknown;
    sha256?: unknown;
  }>;
  runtimeApiVersion?: unknown;
  minimumShellVersion?: unknown;
  sharedProtocolVersion?: unknown;
}

interface ValidRuntimeManifest extends RuntimeManifest {
  schemaVersion: 1;
  releaseId: string;
  runtimeApiVersion: 1;
  minimumShellVersion: string;
  sharedProtocolVersion: string;
  frontend: {
    distDir: string;
    index: string;
  };
  backend: {
    entry: string;
  };
  cli: {
    entry: string;
  };
  appServer: {
    entry: string;
  };
  files: Array<{
    path: string;
    sha256: string;
  }>;
}

interface RuntimeReleaseOptions {
  runtimeRoot: string | null;
  resourcesPath?: string;
  shellVersion?: string;
}

const CURRENT_RUNTIME_FILE = "current.json";
const LAST_KNOWN_GOOD_RUNTIME_FILE = "last-known-good.json";
const BUNDLED_RUNTIME_RELEASE_ID = "bundled";
const CURRENT_RUNTIME_API_VERSION = 1;
const CURRENT_SHARED_PROTOCOL_VERSION = "0.1.0";

export function resolveBundledRuntimeRelease(
  resourcesPath: string = process.resourcesPath,
): RuntimeRelease {
  return {
    source: "bundled",
    releaseId: BUNDLED_RUNTIME_RELEASE_ID,
    frontendDistDir: path.join(resourcesPath, "frontend", "dist"),
    backendEntry: path.join(
      resourcesPath,
      "app.asar",
      "dist",
      "backend",
      "index.cjs",
    ),
    cliEntry: path.join(
      resourcesPath,
      "app.asar",
      "dist",
      "cli",
      "index.cjs",
    ),
    appServerEntry: path.join(
      resourcesPath,
      "app.asar",
      "dist",
      "app-server",
      "index.cjs",
    ),
    nodePtyDir: path.join(resourcesPath, "backend", "node_modules", "node-pty"),
    runtimeRoot: null,
    releaseDir: null,
  };
}

export function resolveRuntimeRoot(userDataPath: string): string {
  return path.join(userDataPath, "runtime");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function isSafeRelativePath(value: unknown): value is string {
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

function isSafeReleaseId(value: unknown): value is string {
  return (
    isSafeRelativePath(value) &&
    !String(value).includes("/") &&
    !String(value).includes("\\")
  );
}

function resolveInside(baseDir: string, relativePath: string): string | null {
  const resolved = path.resolve(baseDir, relativePath);
  const base = path.resolve(baseDir);
  if (resolved !== base && resolved.startsWith(`${base}${path.sep}`)) {
    return resolved;
  }
  return null;
}

function readRuntimePointer(filePath: string): string | null {
  const pointer = readJsonFile<RuntimePointer>(filePath);
  if (!isSafeReleaseId(pointer?.releaseId)) {
    return null;
  }
  return pointer.releaseId;
}

export function resolveCurrentRuntimeReleaseId(
  runtimeRoot: string | null,
): string | null {
  if (!runtimeRoot) {
    return null;
  }

  return readRuntimePointer(path.join(runtimeRoot, CURRENT_RUNTIME_FILE));
}

function parseVersion(value: string): number[] {
  return value
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isVersionGreaterThan(left: string, right: string): boolean {
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

function isSameVersion(left: string, right: string): boolean {
  return !isVersionGreaterThan(left, right) && !isVersionGreaterThan(right, left);
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function validateManifestPaths(
  manifest: RuntimeManifest,
  releaseId: string,
  shellVersion: string | null,
): manifest is ValidRuntimeManifest {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.releaseId !== releaseId ||
    manifest.runtimeApiVersion !== CURRENT_RUNTIME_API_VERSION ||
    manifest.sharedProtocolVersion !== CURRENT_SHARED_PROTOCOL_VERSION
  ) {
    return false;
  }

  if (
    typeof manifest.minimumShellVersion !== "string" ||
    !manifest.minimumShellVersion.trim()
  ) {
    return false;
  }

  // Runtime packages are built with the shell version that produced them. Once
  // the app upgrades, the bundled runtime should not be shadowed by an older
  // hot-update pointer.
  if (
    shellVersion &&
    !isSameVersion(manifest.minimumShellVersion, shellVersion)
  ) {
    return false;
  }

  if (
    !isSafeRelativePath(manifest.frontend?.distDir) ||
    !isSafeRelativePath(manifest.frontend?.index) ||
    !isSafeRelativePath(manifest.backend?.entry) ||
    !isSafeRelativePath(manifest.cli?.entry) ||
    !isSafeRelativePath(manifest.appServer?.entry)
  ) {
    return false;
  }

  if (!Array.isArray(manifest.files)) {
    return false;
  }

  for (const file of manifest.files) {
    if (
      !isSafeRelativePath(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      return false;
    }
  }

  return true;
}

export function resolveExternalRuntimeRelease(options: {
  runtimeRoot: string;
  resourcesPath?: string;
  releaseId: string;
  shellVersion?: string;
}): RuntimeRelease | null {
  try {
    const releaseId = options.releaseId;
    if (!isSafeReleaseId(releaseId)) {
      return null;
    }

    const releaseDir = path.join(options.runtimeRoot, "releases", releaseId);
    const manifestPath = path.join(releaseDir, "manifest.json");
    const manifest = readJsonFile<RuntimeManifest>(manifestPath);
    if (
      !manifest ||
      !validateManifestPaths(manifest, releaseId, options.shellVersion ?? null)
    ) {
      return null;
    }

    const frontendDistDir = resolveInside(
      releaseDir,
      manifest.frontend.distDir,
    );
    const frontendIndex = resolveInside(releaseDir, manifest.frontend.index);
    const backendEntry = resolveInside(releaseDir, manifest.backend.entry);
    const cliEntry = resolveInside(releaseDir, manifest.cli.entry);
    const appServerEntry = resolveInside(
      releaseDir,
      manifest.appServer.entry,
    );
    if (
      !frontendDistDir ||
      !frontendIndex ||
      !backendEntry ||
      !cliEntry ||
      !appServerEntry
    ) {
      return null;
    }

    const manifestFiles = manifest.files
      .map((file) => ({
        ...file,
        filePath: resolveInside(releaseDir, file.path),
      }))
      .filter((file): file is typeof file & { filePath: string } =>
        Boolean(file.filePath),
      );

    const filesToCheck = [
      frontendIndex,
      backendEntry,
      cliEntry,
      appServerEntry,
      ...manifestFiles.map((file) => file.filePath),
    ];

    if (filesToCheck.some((filePath) => !existsSync(filePath))) {
      return null;
    }

    for (const file of manifestFiles) {
      if (sha256(file.filePath) !== file.sha256.toLowerCase()) {
        return null;
      }
    }

    return {
      source: "external",
      releaseId,
      frontendDistDir,
      backendEntry,
      cliEntry,
      appServerEntry,
      nodePtyDir: resolveBundledRuntimeRelease(options.resourcesPath)
        .nodePtyDir,
      runtimeRoot: options.runtimeRoot,
      releaseDir,
    };
  } catch {
    return null;
  }
}

export function resolveActiveRuntimeRelease(
  options: RuntimeReleaseOptions,
): RuntimeRelease {
  const bundled = resolveBundledRuntimeRelease(options.resourcesPath);
  if (!options.runtimeRoot) {
    return bundled;
  }

  const releaseId = resolveCurrentRuntimeReleaseId(options.runtimeRoot);
  if (!releaseId) {
    return bundled;
  }

  return (
    resolveExternalRuntimeRelease({
      runtimeRoot: options.runtimeRoot,
      resourcesPath: options.resourcesPath,
      releaseId,
      shellVersion: options.shellVersion,
    }) ?? bundled
  );
}

export function resolveLastKnownGoodRuntimeRelease(
  options: RuntimeReleaseOptions,
): RuntimeRelease | null {
  if (!options.runtimeRoot) {
    return null;
  }

  const releaseId = readRuntimePointer(
    path.join(options.runtimeRoot, LAST_KNOWN_GOOD_RUNTIME_FILE),
  );
  if (!releaseId) {
    return null;
  }

  return resolveExternalRuntimeRelease({
    runtimeRoot: options.runtimeRoot,
    resourcesPath: options.resourcesPath,
    releaseId,
    shellVersion: options.shellVersion,
  });
}

export function recordLastKnownGoodRuntimeRelease(
  release: RuntimeRelease,
): void {
  if (release.source !== "external" || !release.runtimeRoot) {
    return;
  }

  mkdirSync(release.runtimeRoot, { recursive: true });
  const target = path.join(release.runtimeRoot, LAST_KNOWN_GOOD_RUNTIME_FILE);
  const temp = `${target}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify(
      {
        releaseId: release.releaseId,
        activatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  renameSync(temp, target);
}
