import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  TerminalPreviewDirectoryResponse,
  TerminalPreviewTreeEntry,
  TerminalPreviewTreeEntryKind,
} from "@browser-viewer/shared";
import {
  EXCLUDED_DIRECTORIES,
  EXCLUDED_FILE_BASENAMES,
} from "./preview-search-candidates";
import { ensureProjectPath, TerminalPreviewError, toRelativePath } from "./preview-paths";

const DEFAULT_DIRECTORY_LIMIT = 500;
const MAX_DIRECTORY_LIMIT = 1000;

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
]);

function isSensitiveEntry(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (SENSITIVE_BASENAMES.has(lower)) return true;
  if (lower.startsWith(".env.") && lower.endsWith(".local")) return true;
  if (lower.includes("secret")) return true;
  return false;
}

function shouldExcludeEntry(basename: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return EXCLUDED_DIRECTORIES.has(basename);
  }
  if (EXCLUDED_FILE_BASENAMES.has(basename)) return true;
  if (isSensitiveEntry(basename)) return true;
  return false;
}

export async function listPreviewDirectory(params: {
  projectId: string;
  projectPath: string | null | undefined;
  relativePath: string;
  limit?: number;
}): Promise<TerminalPreviewDirectoryResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const rootPath = await realpath(projectPath);

  const requestedPath = params.relativePath.trim();
  const targetAbsolute = requestedPath
    ? path.resolve(rootPath, requestedPath)
    : rootPath;

  const resolvedTarget = await realpath(targetAbsolute).catch(() => null);
  if (!resolvedTarget) {
    throw new TerminalPreviewError("Directory not found", 404);
  }

  const relative = path.relative(rootPath, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TerminalPreviewError("Path is outside the project path", 403);
  }

  const targetStat = await stat(resolvedTarget);
  if (!targetStat.isDirectory()) {
    throw new TerminalPreviewError("Path is not a directory", 400);
  }

  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_DIRECTORY_LIMIT, MAX_DIRECTORY_LIMIT));

  const dirents = await readdir(resolvedTarget, { withFileTypes: true }).catch(
    (error) => {
      throw new TerminalPreviewError(
        `Cannot read directory: ${(error as Error).message}`,
        500,
      );
    },
  );

  const entries: TerminalPreviewTreeEntry[] = [];

  for (const dirent of dirents) {
    const isDir = dirent.isDirectory();
    const isFile = dirent.isFile() || dirent.isSymbolicLink();
    if (!isDir && !isFile) continue;
    if (shouldExcludeEntry(dirent.name, isDir)) continue;

    const entryAbsolute = path.join(resolvedTarget, dirent.name);
    const entryRelative = toRelativePath(rootPath, entryAbsolute);
    const kind: TerminalPreviewTreeEntryKind = isDir ? "directory" : "file";

    const entry: TerminalPreviewTreeEntry = {
      kind,
      path: entryRelative,
      basename: dirent.name,
      dirname: requestedPath || ".",
    };

    if (isDir) {
      entry.hasChildren = true;
    }

    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.basename.localeCompare(b.basename);
  });

  const truncated = entries.length > limit;
  const limitedEntries = truncated ? entries.slice(0, limit) : entries;

  return {
    kind: "directory",
    projectId: params.projectId,
    projectPath,
    path: requestedPath || ".",
    absolutePath: resolvedTarget,
    entries: limitedEntries,
    limit,
    truncated,
  };
}
