import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { TerminalPreviewBase } from "@browser-viewer/shared";

export class TerminalPreviewError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function normalizeProjectPath(
  projectPath: string | null | undefined,
): Promise<string | null> {
  const trimmed = projectPath?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const stats = await stat(trimmed);
    if (!stats.isDirectory()) {
      return null;
    }
    await access(trimmed, constants.R_OK);
    return await realpath(trimmed);
  } catch {
    return null;
  }
}

export function ensureProjectPath(projectPath: string | null | undefined): string {
  if (!projectPath) {
    throw new TerminalPreviewError("Set a project path to use Preview", 409);
  }
  return projectPath;
}

export function toRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolvePreviewPath(
  projectPath: string,
  requestedPath: string,
  options?: { allowAbsoluteOutsideProject?: boolean },
): Promise<{
  absolutePath: string;
  base: TerminalPreviewBase;
  previewPath: string;
  relativePath: string;
}> {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new TerminalPreviewError("Enter a file path", 400);
  }
  if (trimmedPath.startsWith("~")) {
    throw new TerminalPreviewError("Home paths are not supported", 400);
  }

  const rootPath = await realpath(projectPath);
  const requestedAbsolutePath = path.isAbsolute(trimmedPath);
  const candidatePath = requestedAbsolutePath
    ? path.resolve(trimmedPath)
    : path.resolve(rootPath, trimmedPath);
  const resolvedCandidatePath = await realpath(candidatePath).catch(() => null);
  const parentPath = resolvedCandidatePath
    ? null
    : await realpath(path.dirname(candidatePath)).catch(() => null);
  const comparablePath =
    resolvedCandidatePath ??
    (parentPath ? path.join(parentPath, path.basename(candidatePath)) : candidatePath);

  if (!isInsidePath(rootPath, comparablePath)) {
    if (options?.allowAbsoluteOutsideProject === true && requestedAbsolutePath) {
      return {
        absolutePath: comparablePath,
        base: "filesystem",
        previewPath: comparablePath,
        relativePath: comparablePath,
      };
    }
    throw new TerminalPreviewError("Path is outside the project path", 403);
  }

  const relativePath = toRelativePath(rootPath, comparablePath);
  return {
    absolutePath: comparablePath,
    base: "project",
    previewPath: relativePath,
    relativePath,
  };
}

export function detectLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".svg":
      return "svg";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

export function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}
