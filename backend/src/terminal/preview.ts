import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TerminalPreviewFileResponse,
  TerminalPreviewBase,
  TerminalPreviewDeleteFileResponse,
  TerminalPreviewSaveFileResponse,
} from "@runweave/shared";
import {
  TerminalPreviewError,
  detectLanguage,
  ensureProjectPath,
  isLikelyBinary,
  resolvePreviewPath,
} from "./preview-paths";
import { clearPreviewFileSearchCache } from "./preview-search";

export { TerminalPreviewError, normalizeProjectPath } from "./preview-paths";
export {
  clearPreviewFileSearchCache,
  searchPreviewFiles,
} from "./preview-search";
export { getPreviewFileDiff, getPreviewGitChanges } from "./preview-git";

const FILE_PREVIEW_MAX_BYTES = 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export interface TerminalPreviewAssetResponse {
  kind: "asset";
  projectId: string;
  path: string;
  absolutePath: string;
  base: TerminalPreviewBase;
  projectPath: string;
  mimeType: string;
  content: Buffer;
  sizeBytes: number;
  cacheControl: "no-store";
  readonly: true;
}

function detectImageMimeType(buffer: Buffer, filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") {
    const sample = buffer
      .subarray(0, Math.min(buffer.length, 4096))
      .toString("utf8");
    if (/<svg[\s>]/i.test(sample)) {
      return "image/svg+xml";
    }
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    buffer.subarray(8, 12).toString("ascii") === "avif"
  ) {
    return "image/avif";
  }
  return null;
}

export async function readPreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
}): Promise<TerminalPreviewFileResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, base, previewPath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
    { allowAbsoluteOutsideProject: true },
  );
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats) {
    throw new TerminalPreviewError("File not found", 404);
  }
  if (fileStats.isDirectory()) {
    throw new TerminalPreviewError("Directories are not supported", 400);
  }
  if (!fileStats.isFile()) {
    throw new TerminalPreviewError("Only regular files can be previewed", 400);
  }
  if (fileStats.size > FILE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("File exceeds preview limit", 413);
  }

  const contentBuffer = await readFile(absolutePath);
  if (isLikelyBinary(contentBuffer)) {
    throw new TerminalPreviewError("Binary files cannot be previewed", 415);
  }

  return {
    kind: "file",
    projectId: params.projectId,
    path: previewPath,
    absolutePath,
    base,
    projectPath,
    language: detectLanguage(previewPath),
    content: contentBuffer.toString("utf8"),
    sizeBytes: fileStats.size,
    mtimeMs: fileStats.mtimeMs,
    readonly: base !== "project",
  };
}

export async function savePreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  content: string;
  expectedMtimeMs: number;
  overwrite?: boolean;
}): Promise<TerminalPreviewSaveFileResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
  );
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats) {
    throw new TerminalPreviewError("File not found", 404);
  }
  if (fileStats.isDirectory()) {
    throw new TerminalPreviewError("Directories are not supported", 400);
  }
  if (!fileStats.isFile()) {
    throw new TerminalPreviewError("Only regular files can be saved", 400);
  }
  if (fileStats.size > FILE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("File exceeds preview limit", 413);
  }
  const contentBuffer = await readFile(absolutePath);
  if (isLikelyBinary(contentBuffer)) {
    throw new TerminalPreviewError("Binary files cannot be saved", 415);
  }
  const nextContentBuffer = Buffer.from(params.content, "utf8");
  if (nextContentBuffer.length > FILE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("File exceeds preview limit", 413);
  }
  if (
    params.overwrite !== true &&
    fileStats.mtimeMs !== params.expectedMtimeMs
  ) {
    throw new TerminalPreviewError("File was modified outside Preview", 409);
  }

  await writeFile(absolutePath, nextContentBuffer);
  const latestStats = await stat(absolutePath);
  clearPreviewFileSearchCache(params.projectId);

  return {
    kind: "file",
    projectId: params.projectId,
    path: relativePath,
    absolutePath,
    base: "project",
    projectPath,
    language: detectLanguage(relativePath),
    content: nextContentBuffer.toString("utf8"),
    sizeBytes: latestStats.size,
    mtimeMs: latestStats.mtimeMs,
    readonly: false,
  };
}

async function assertRegularPreviewFile(
  absolutePath: string,
  action: "delete" | "rename",
) {
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats) {
    throw new TerminalPreviewError("File not found", 404);
  }
  if (fileStats.isDirectory()) {
    throw new TerminalPreviewError("Directories are not supported", 400);
  }
  if (!fileStats.isFile()) {
    throw new TerminalPreviewError(`Only regular files can be ${action}d`, 400);
  }
  return fileStats;
}

function assertExpectedMtime(
  fileStats: Awaited<ReturnType<typeof stat>>,
  expectedMtimeMs: number | undefined,
): void {
  if (expectedMtimeMs !== undefined && fileStats.mtimeMs !== expectedMtimeMs) {
    throw new TerminalPreviewError("File was modified outside Preview", 409);
  }
}

export async function deletePreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  expectedMtimeMs?: number;
}): Promise<TerminalPreviewDeleteFileResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
  );
  const fileStats = await assertRegularPreviewFile(absolutePath, "delete");
  assertExpectedMtime(fileStats, params.expectedMtimeMs);

  await unlink(absolutePath);
  clearPreviewFileSearchCache(params.projectId);

  return {
    kind: "file-delete",
    projectId: params.projectId,
    path: relativePath,
    absolutePath,
  };
}

export async function renamePreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  nextRequestedPath: string;
  expectedMtimeMs?: number;
}): Promise<TerminalPreviewFileResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
  );
  const { absolutePath: nextAbsolutePath, relativePath: nextRelativePath } =
    await resolvePreviewPath(projectPath, params.nextRequestedPath);
  const fileStats = await assertRegularPreviewFile(absolutePath, "rename");
  assertExpectedMtime(fileStats, params.expectedMtimeMs);
  if (fileStats.size > FILE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("File exceeds preview limit", 413);
  }
  const contentBuffer = await readFile(absolutePath);
  if (isLikelyBinary(contentBuffer)) {
    throw new TerminalPreviewError("Binary files cannot be previewed", 415);
  }

  const nextStats = await stat(nextAbsolutePath).catch(() => null);
  if (nextStats) {
    throw new TerminalPreviewError("Target file already exists", 409);
  }

  const parentStats = await stat(path.dirname(nextAbsolutePath)).catch(
    () => null,
  );
  if (!parentStats || !parentStats.isDirectory()) {
    throw new TerminalPreviewError(
      "Target parent directory does not exist",
      400,
    );
  }

  await rename(absolutePath, nextAbsolutePath);
  clearPreviewFileSearchCache(params.projectId);

  return readPreviewFile({
    projectId: params.projectId,
    projectPath,
    requestedPath: nextRelativePath,
  });
}

export async function readPreviewAsset(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
}): Promise<TerminalPreviewAssetResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, base, previewPath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
    { allowAbsoluteOutsideProject: true },
  );
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats) {
    throw new TerminalPreviewError("File not found", 404);
  }
  if (fileStats.isDirectory()) {
    throw new TerminalPreviewError("Directories are not supported", 400);
  }
  if (!fileStats.isFile()) {
    throw new TerminalPreviewError("Only regular files can be previewed", 400);
  }
  if (fileStats.size > IMAGE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("Image exceeds preview limit", 413);
  }

  const content = await readFile(absolutePath);
  const mimeType = detectImageMimeType(content, previewPath);
  if (!mimeType) {
    throw new TerminalPreviewError("Image format is not supported", 415);
  }

  return {
    kind: "asset",
    projectId: params.projectId,
    path: previewPath,
    absolutePath,
    base,
    projectPath,
    mimeType,
    content,
    sizeBytes: fileStats.size,
    cacheControl: "no-store",
    readonly: true,
  };
}
