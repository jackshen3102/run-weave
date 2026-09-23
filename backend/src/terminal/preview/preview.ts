import { detectImageMimeType, IMAGE_PREVIEW_MAX_BYTES } from "./image-format";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TerminalPreviewFileResponse, TerminalPreviewBase, TerminalPreviewDeleteFileResponse, TerminalPreviewResetChangeResponse, TerminalPreviewSaveFileResponse, TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";
import { resetPreviewGitChange as resetPreviewGitChangeFromGit } from "./git";
import {
  TerminalPreviewError,
  detectLanguage,
  ensureProjectPath,
  isLikelyBinary,
  resolvePreviewPath,
} from "./paths";
import { clearPreviewFileSearchCache } from "./search";

export { TerminalPreviewError, normalizeProjectPath } from "./paths";
export {
  clearPreviewFileSearchCache,
  searchPreviewFiles,
  searchPreviewFolders,
} from "./search";
export { searchPreviewContent } from "./content-search";
export { getPreviewFileDiff, getPreviewGitChanges } from "./git";

const FILE_PREVIEW_MAX_BYTES = 1024 * 1024;


export interface TerminalPreviewAssetResponse {
  kind: "asset";
  projectId: string;
  path: string;
  absolutePath: string;
  base: TerminalPreviewBase;
  projectPath: string | null;
  mimeType: string;
  content: Buffer;
  sizeBytes: number;
  cacheControl: "no-store";
  readonly: true;
}

export async function readPreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
}): Promise<TerminalPreviewFileResponse> {
  const projectPath = params.projectPath ?? null;
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

export async function resetPreviewGitChange(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  changeKind: TerminalPreviewChangeKind;
}): Promise<TerminalPreviewResetChangeResponse> {
  const payload = await resetPreviewGitChangeFromGit(params);
  clearPreviewFileSearchCache(params.projectId);
  return payload;
}

export async function readPreviewAsset(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
}): Promise<TerminalPreviewAssetResponse> {
  const projectPath = params.projectPath ?? null;
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
