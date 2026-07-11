import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const SOURCE_EXTENSION =
  /\.(?:cjs|css|h|java|js|jsx|kt|kts|m|mjs|mm|py|scss|sh|swift|ts|tsx)$/;
const ROOT_SOURCE_FILE =
  /^(?:app-dev|dev|electron-dev|start)\.mjs$|^eslint\.config\.mjs$/;
const INCLUDED_PREFIXES = [
  "app/",
  "app-server/",
  "backend/",
  "electron/",
  "frontend/",
  "packages/",
  "plugins/toolkit/",
  "scripts/",
];
const INCLUDED_FILES = new Set([
  ".husky/pre-commit",
  ".husky/pre-push",
  "frontend/playwright.config.ts",
]);
const EXCLUDED_SEGMENTS = new Set([
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

export function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

export function isArchitectureSourceFile(filePath, options = {}) {
  const normalized = normalizeRelativePath(filePath);
  if (!SOURCE_EXTENSION.test(normalized) && !INCLUDED_FILES.has(normalized)) {
    return false;
  }
  if (normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
    return false;
  }
  if (options.allSupportedFiles) {
    return true;
  }
  if (INCLUDED_FILES.has(normalized) || ROOT_SOURCE_FILE.test(normalized)) {
    return true;
  }
  return INCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function countPhysicalLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split(/\r\n|\n|\r/).length;
  return /(?:\r\n|\n|\r)$/.test(content) ? lines - 1 : lines;
}

export async function readSourceFile(root, relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

export async function listArchitectureSourceFiles(root = REPO_ROOT) {
  const resolvedRoot = path.resolve(root);
  const candidates =
    resolvedRoot === REPO_ROOT
      ? listGitVisibleFiles(resolvedRoot)
      : await walkFiles(resolvedRoot);
  const allSupportedFiles = resolvedRoot !== REPO_ROOT;
  return candidates
    .map(normalizeRelativePath)
    .filter((filePath) =>
      isArchitectureSourceFile(filePath, { allSupportedFiles }),
    )
    .sort();
}

export function moduleForFile(filePath) {
  const parts = normalizeRelativePath(filePath).split("/");
  if (parts[0] === "packages") {
    return `packages/${parts[1] ?? "unknown"}`;
  }
  if (parts[0] === "plugins") {
    return "plugins/toolkit";
  }
  return parts.length === 1 ? "root" : parts[0];
}

function listGitVisibleFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter((filePath) => filePath && existsSync(path.join(root, filePath)));
}

async function walkFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(path.relative(root, absolutePath));
    }
  }
  return files;
}
