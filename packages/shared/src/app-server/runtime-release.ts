import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RUNTIME_SCHEMA_VERSION,
  type AppServerRuntimeRelease,
} from "./types";
import { resolveAppServerRuntimeRoot } from "./paths";

interface AppServerRuntimeManifest {
  schemaVersion?: unknown;
  releaseId?: unknown;
  appServer?: {
    entry?: unknown;
  };
  protocolVersion?: unknown;
  files?: Array<{
    path?: unknown;
    sha256?: unknown;
  }>;
}

interface AppServerRuntimePointer {
  releaseId?: unknown;
}

export function resolveCurrentAppServerRuntimeRelease(
  options: {
    env?: NodeJS.ProcessEnv;
    runtimeRoot?: string;
  } = {},
): AppServerRuntimeRelease | null {
  const runtimeRoot =
    options.runtimeRoot ?? resolveAppServerRuntimeRoot({ env: options.env });
  const pointer = readJsonFile<AppServerRuntimePointer>(
    path.join(runtimeRoot, "current.json"),
  );
  if (!isSafeReleaseId(pointer?.releaseId)) {
    return null;
  }

  const releaseId = pointer.releaseId;
  const releaseDir = path.join(runtimeRoot, "releases", releaseId);
  const manifest = readJsonFile<AppServerRuntimeManifest>(
    path.join(releaseDir, "manifest.json"),
  );
  if (!isValidAppServerRuntimeManifest(manifest, releaseId)) {
    return null;
  }

  const entry = resolveInside(releaseDir, manifest.appServer.entry);
  if (!entry || !existsSync(entry)) {
    return null;
  }

  for (const file of manifest.files) {
    const filePath = resolveInside(releaseDir, file.path);
    if (
      !filePath ||
      !existsSync(filePath) ||
      sha256(filePath) !== file.sha256
    ) {
      return null;
    }
  }

  return {
    source: "global",
    releaseId,
    entry,
    releaseDir,
    runtimeRoot,
  };
}

export function installAppServerRuntimeRelease(options: {
  entry: string;
  releaseId: string;
  env?: NodeJS.ProcessEnv;
  runtimeRoot?: string;
}): AppServerRuntimeRelease {
  if (!isSafeReleaseId(options.releaseId)) {
    throw new Error(`Invalid app-server releaseId: ${options.releaseId}`);
  }

  const sourceEntry = path.resolve(options.entry);
  if (!existsSync(sourceEntry)) {
    throw new Error(`App-server entry does not exist: ${sourceEntry}`);
  }

  const runtimeRoot =
    options.runtimeRoot ?? resolveAppServerRuntimeRoot({ env: options.env });
  const releasesDir = path.join(runtimeRoot, "releases");
  const releaseDir = path.join(releasesDir, options.releaseId);
  const tempReleaseDir = path.join(releasesDir, `${options.releaseId}.tmp`);
  const targetEntry = path.join(tempReleaseDir, "app-server", "index.cjs");

  rmSync(tempReleaseDir, { recursive: true, force: true });
  mkdirSync(path.dirname(targetEntry), { recursive: true });
  cpSync(sourceEntry, targetEntry);

  const manifest = {
    schemaVersion: APP_SERVER_RUNTIME_SCHEMA_VERSION,
    releaseId: options.releaseId,
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    appServer: {
      entry: "app-server/index.cjs",
    },
    files: [
      {
        path: "app-server/index.cjs",
        sha256: sha256(targetEntry),
      },
    ],
  };
  writeFileSync(
    path.join(tempReleaseDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  mkdirSync(releasesDir, { recursive: true });
  rmSync(releaseDir, { recursive: true, force: true });
  renameSync(tempReleaseDir, releaseDir);

  const currentPath = path.join(runtimeRoot, "current.json");
  const currentTemp = `${currentPath}.tmp`;
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    currentTemp,
    `${JSON.stringify(
      {
        releaseId: options.releaseId,
        activatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  renameSync(currentTemp, currentPath);

  return {
    source: "global",
    releaseId: options.releaseId,
    entry: path.join(releaseDir, "app-server", "index.cjs"),
    releaseDir,
    runtimeRoot,
  };
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return false;
  }
  return trimmed
    .split(/[\\/]+/)
    .every((segment) => segment && segment !== "." && segment !== "..");
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

function isValidAppServerRuntimeManifest(
  manifest: AppServerRuntimeManifest | null,
  releaseId: string,
): manifest is Required<AppServerRuntimeManifest> & {
  appServer: { entry: string };
  files: Array<{ path: string; sha256: string }>;
} {
  return Boolean(
    manifest &&
    manifest.schemaVersion === APP_SERVER_RUNTIME_SCHEMA_VERSION &&
    manifest.releaseId === releaseId &&
    manifest.protocolVersion === APP_SERVER_PROTOCOL_VERSION &&
    isSafeRelativePath(manifest.appServer?.entry) &&
    Array.isArray(manifest.files) &&
    manifest.files.every(
      (file) =>
        isSafeRelativePath(file.path) &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/i.test(file.sha256),
    ),
  );
}
