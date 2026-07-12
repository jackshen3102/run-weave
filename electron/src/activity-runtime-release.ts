import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

interface ActivityRuntimeManifest {
  schemaVersion?: unknown;
  electronVersion?: unknown;
  nodeModuleAbi?: unknown;
  platform?: unknown;
  arch?: unknown;
  workerEntry?: unknown;
  packageEntry?: unknown;
  packageManifest?: unknown;
  nativeBinding?: unknown;
  files?: Array<{ path?: unknown; size?: unknown; sha256?: unknown }>;
  treeSha256?: unknown;
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    return false;
  }
  return value.split(/[\\/]+/).every((segment) => segment && segment !== "." && segment !== "..");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function listFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("activity_runtime_symlink_not_allowed");
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function treeSha256(files: Array<{ path: string; size: number; sha256: string }>): string {
  return createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n"))
    .digest("hex");
}

export function validateBundledActivityRuntime(resourcesPath: string): boolean {
  try {
    const root = path.join(resourcesPath, "backend");
    const manifest = JSON.parse(
      readFileSync(path.join(root, "activity-sqlite-runtime-manifest.json"), "utf8"),
    ) as ActivityRuntimeManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      (process.versions.electron && manifest.electronVersion !== process.versions.electron) ||
      (process.versions.modules && manifest.nodeModuleAbi !== process.versions.modules) ||
      !isSafeRelativePath(manifest.workerEntry) ||
      !isSafeRelativePath(manifest.packageEntry) ||
      !isSafeRelativePath(manifest.packageManifest) ||
      !isSafeRelativePath(manifest.nativeBinding) ||
      !Array.isArray(manifest.files) ||
      !isSha256(manifest.treeSha256)
    ) {
      return false;
    }
    const expected = manifest.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    }));
    if (
      expected.some((file) =>
        !isSafeRelativePath(file.path) ||
        typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !isSha256(file.sha256),
      ) ||
      new Set(expected.map((file) => file.path)).size !== expected.length
    ) {
      return false;
    }
    const roots = [
      manifest.workerEntry,
      "node_modules/better-sqlite3",
      "node_modules/bindings",
      "node_modules/file-uri-to-path",
    ].map((relative) => path.join(root, relative));
    const actual = roots.flatMap((entry) =>
      statSync(entry).isDirectory()
        ? listFiles(root, entry)
        : [path.relative(root, entry).split(path.sep).join("/")],
    ).sort();
    const expectedPaths = expected.map((file) => file.path as string).sort();
    if (
      actual.length !== expectedPaths.length ||
      actual.some((filePath, index) => filePath !== expectedPaths[index])
    ) {
      return false;
    }
    const verified = expected.map((file) => {
      const absolute = path.join(root, file.path as string);
      if (statSync(absolute).size !== file.size || sha256(absolute) !== file.sha256) {
        throw new Error("activity_runtime_file_mismatch");
      }
      return file as { path: string; size: number; sha256: string };
    });
    return treeSha256(verified) === manifest.treeSha256.toLowerCase();
  } catch {
    return false;
  }
}
