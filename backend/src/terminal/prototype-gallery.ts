import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { TerminalPrototypeGalleryItem, TerminalPrototypeGalleryProject, TerminalPrototypeGalleryResponse } from "@runweave/shared/terminal/preview";
import type { TerminalProjectRecord } from "./manager-records";

const PROTOTYPE_ROOT_PARTS = ["docs", "prototypes"] as const;
const INDEX_FILE = "index.html";
const README_FILE = "README.md";

export class TerminalPrototypeGalleryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function fileErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function titleFromHtml(content: string): string | null {
  return (
    /<title(?:\s[^>]*)?>([^<]+)<\/title>/i.exec(content)?.[1]?.trim() ?? null
  );
}

function titleFromMarkdown(content: string): string | null {
  return /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? null;
}

async function readPrototypeTitle(
  prototypePath: string,
  files: string[],
  fallback: string,
): Promise<string> {
  if (files.includes(INDEX_FILE)) {
    const html = await readFile(
      path.join(prototypePath, INDEX_FILE),
      "utf8",
    ).catch(() => null);
    const htmlTitle = html ? titleFromHtml(html) : null;
    if (htmlTitle) {
      return htmlTitle;
    }
  }
  if (files.includes(README_FILE)) {
    const markdown = await readFile(
      path.join(prototypePath, README_FILE),
      "utf8",
    ).catch(() => null);
    const markdownTitle = markdown ? titleFromMarkdown(markdown) : null;
    if (markdownTitle) {
      return markdownTitle;
    }
  }
  return fallback;
}

async function scanPrototypeDirectory(params: {
  projectId: string;
  prototypeRootPath: string;
  slug: string;
}): Promise<TerminalPrototypeGalleryItem | null> {
  const candidatePath = path.join(params.prototypeRootPath, params.slug);
  const prototypePath = await realpath(candidatePath).catch(() => null);
  if (
    !prototypePath ||
    !isInsidePath(params.prototypeRootPath, prototypePath)
  ) {
    return null;
  }
  const prototypeStat = await stat(prototypePath).catch(() => null);
  if (!prototypeStat?.isDirectory()) {
    return null;
  }
  const entries = await readdir(prototypePath, { withFileTypes: true }).catch(
    () => [],
  );
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const entry = files.includes(INDEX_FILE) ? INDEX_FILE : null;
  return {
    projectId: params.projectId,
    slug: params.slug,
    title: await readPrototypeTitle(prototypePath, files, params.slug),
    entry,
    files,
  };
}

async function scanProject(
  project: TerminalProjectRecord,
): Promise<TerminalPrototypeGalleryProject> {
  const base = {
    projectId: project.id,
    name: project.name,
    path: project.path,
    prototypes: [] as TerminalPrototypeGalleryItem[],
  };
  if (!project.path) {
    return { ...base, status: "project-path-missing" };
  }

  const projectPath = await realpath(project.path).catch(() => null);
  if (!projectPath) {
    return { ...base, status: "prototype-root-unavailable" };
  }
  const prototypeRootCandidate = path.join(
    projectPath,
    ...PROTOTYPE_ROOT_PARTS,
  );
  let prototypeRootPath: string;
  try {
    prototypeRootPath = await realpath(prototypeRootCandidate);
  } catch (error) {
    return {
      ...base,
      status:
        fileErrorCode(error) === "ENOENT"
          ? "prototype-root-missing"
          : "prototype-root-unavailable",
    };
  }
  if (!isInsidePath(projectPath, prototypeRootPath)) {
    return { ...base, status: "prototype-root-unavailable" };
  }
  const rootStat = await stat(prototypeRootPath).catch(() => null);
  if (!rootStat?.isDirectory()) {
    return { ...base, status: "prototype-root-unavailable" };
  }

  let rootEntries;
  try {
    rootEntries = await readdir(prototypeRootPath, { withFileTypes: true });
  } catch {
    return { ...base, status: "prototype-root-unavailable" };
  }
  const slugs = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const prototypes = (
    await Promise.all(
      slugs.map((slug) =>
        scanPrototypeDirectory({
          projectId: project.id,
          prototypeRootPath,
          slug,
        }),
      ),
    )
  ).filter((item): item is TerminalPrototypeGalleryItem => item !== null);
  return { ...base, status: "available", prototypes };
}

export async function listTerminalPrototypeGallery(
  projects: TerminalProjectRecord[],
): Promise<TerminalPrototypeGalleryResponse> {
  return {
    projects: await Promise.all(
      projects.map((project) => scanProject(project)),
    ),
  };
}

function validatePrototypeSlug(prototypeSlug: string): void {
  if (
    !prototypeSlug ||
    prototypeSlug === "." ||
    prototypeSlug === ".." ||
    prototypeSlug.includes("/") ||
    prototypeSlug.includes("\\")
  ) {
    throw new TerminalPrototypeGalleryError("Invalid prototype path", 400);
  }
}

async function resolvePrototypeDirectory(params: {
  projectPath: string | null;
  prototypeSlug: string;
}): Promise<string> {
  validatePrototypeSlug(params.prototypeSlug);
  if (!params.projectPath) {
    throw new TerminalPrototypeGalleryError("Project path is not set", 409);
  }
  const projectPath = await realpath(params.projectPath).catch(() => null);
  if (!projectPath) {
    throw new TerminalPrototypeGalleryError("Project path is unavailable", 409);
  }
  const prototypeRootPath = await realpath(
    path.join(projectPath, ...PROTOTYPE_ROOT_PARTS),
  ).catch(() => null);
  if (!prototypeRootPath || !isInsidePath(projectPath, prototypeRootPath)) {
    throw new TerminalPrototypeGalleryError(
      "Prototype directory not found",
      404,
    );
  }
  const prototypePath = await realpath(
    path.join(prototypeRootPath, params.prototypeSlug),
  ).catch(() => null);
  if (!prototypePath || !isInsidePath(prototypeRootPath, prototypePath)) {
    throw new TerminalPrototypeGalleryError("Prototype not found", 404);
  }
  const relative = path.relative(prototypeRootPath, prototypePath);
  if (!relative || relative.includes(path.sep) || path.isAbsolute(relative)) {
    throw new TerminalPrototypeGalleryError("Prototype not found", 404);
  }
  const prototypeStat = await stat(prototypePath).catch(() => null);
  if (!prototypeStat?.isDirectory()) {
    throw new TerminalPrototypeGalleryError("Prototype not found", 404);
  }
  return prototypePath;
}

export async function assertTerminalPrototypePreviewEntry(params: {
  projectPath: string | null;
  prototypeSlug: string;
}): Promise<void> {
  const prototypePath = await resolvePrototypeDirectory(params);
  const entryPath = await realpath(path.join(prototypePath, INDEX_FILE)).catch(
    () => null,
  );
  if (!entryPath || !isInsidePath(prototypePath, entryPath)) {
    throw new TerminalPrototypeGalleryError("Prototype entry not found", 404);
  }
  const entryStat = await stat(entryPath).catch(() => null);
  if (!entryStat?.isFile()) {
    throw new TerminalPrototypeGalleryError("Prototype entry not found", 404);
  }
}

export async function resolveTerminalPrototypePreviewFile(params: {
  projectPath: string | null;
  prototypeSlug: string;
  requestedPath: string;
}): Promise<{
  filePath: string;
  size: number;
  stream: ReturnType<typeof createReadStream>;
}> {
  const prototypePath = await resolvePrototypeDirectory(params);
  const requestedPath = params.requestedPath.trim() || INDEX_FILE;
  if (path.isAbsolute(requestedPath)) {
    throw new TerminalPrototypeGalleryError(
      "Path is outside the prototype",
      403,
    );
  }
  const candidatePath = path.resolve(prototypePath, requestedPath);
  let filePath = await realpath(candidatePath).catch(() => null);
  if (!filePath || !isInsidePath(prototypePath, filePath)) {
    throw new TerminalPrototypeGalleryError("Prototype file not found", 404);
  }
  let fileStat = await stat(filePath).catch(() => null);
  if (fileStat?.isDirectory()) {
    filePath = await realpath(path.join(filePath, INDEX_FILE)).catch(
      () => null,
    );
    if (!filePath || !isInsidePath(prototypePath, filePath)) {
      throw new TerminalPrototypeGalleryError("Prototype file not found", 404);
    }
    fileStat = await stat(filePath).catch(() => null);
  }
  if (!fileStat?.isFile()) {
    throw new TerminalPrototypeGalleryError("Prototype file not found", 404);
  }
  return {
    filePath,
    size: fileStat.size,
    stream: createReadStream(filePath),
  };
}
