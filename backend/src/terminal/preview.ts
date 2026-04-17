import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewFileSearchResponse,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewGitStatus,
} from "@browser-viewer/shared";

const execFileAsync = promisify(execFile);

const FILE_PREVIEW_MAX_BYTES = 1024 * 1024;
const GIT_FILE_CONTENT_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_FILES = 20_000;
const DEFAULT_SEARCH_LIMIT = 50;
const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "vendor",
]);

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

function ensureProjectPath(projectPath: string | null | undefined): string {
  if (!projectPath) {
    throw new TerminalPreviewError("Set a project path to use Preview", 409);
  }
  return projectPath;
}

function toRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvePreviewPath(
  projectPath: string,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new TerminalPreviewError("Enter a file path", 400);
  }
  if (trimmedPath.startsWith("~")) {
    throw new TerminalPreviewError("Home paths are not supported", 400);
  }

  const rootPath = await realpath(projectPath);
  const candidatePath = path.isAbsolute(trimmedPath)
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
    throw new TerminalPreviewError("Path is outside the project path", 403);
  }

  return {
    absolutePath: comparablePath,
    relativePath: toRelativePath(rootPath, comparablePath),
  };
}

function detectLanguage(filePath: string): string {
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

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export async function readPreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
}): Promise<TerminalPreviewFileResponse> {
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
    path: relativePath,
    absolutePath,
    base: "project",
    projectPath,
    language: detectLanguage(relativePath),
    content: contentBuffer.toString("utf8"),
    sizeBytes: fileStats.size,
    readonly: true,
  };
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzyScore(query: string, candidate: string): number {
  const compactQuery = compactText(query);
  const compactCandidate = compactText(candidate);
  if (!compactQuery) {
    return 0;
  }
  if (compactCandidate === compactQuery) {
    return 100;
  }
  if (compactCandidate.startsWith(compactQuery)) {
    return 90 - compactCandidate.length / 1000;
  }
  if (compactCandidate.includes(compactQuery)) {
    return 75 - compactCandidate.indexOf(compactQuery) / 1000;
  }

  let queryIndex = 0;
  let score = 0;
  for (let candidateIndex = 0; candidateIndex < compactCandidate.length; candidateIndex += 1) {
    if (compactCandidate[candidateIndex] !== compactQuery[queryIndex]) {
      continue;
    }
    queryIndex += 1;
    score += 1;
    if (queryIndex === compactQuery.length) {
      return 40 + (score / compactCandidate.length) * 20;
    }
  }
  return 0;
}

function rankFile(query: string, relativePath: string): TerminalPreviewFileSearchItem | null {
  const basename = path.posix.basename(relativePath);
  const dirname = path.posix.dirname(relativePath);
  const normalizedDirname = dirname === "." ? "" : dirname;
  const basenameScore = fuzzyScore(query, basename);
  const pathScore = fuzzyScore(query, relativePath);
  const segmentScore = relativePath
    .split("/")
    .reduce((best, segment) => Math.max(best, fuzzyScore(query, segment)), 0);
  const score = Math.max(
    basenameScore > 0 ? basenameScore + 20 : 0,
    segmentScore > 0 ? segmentScore + 10 : 0,
    pathScore,
  );
  if (score <= 0) {
    return null;
  }

  return {
    path: relativePath,
    basename,
    dirname: normalizedDirname,
    reason:
      basenameScore >= pathScore
        ? "basename fuzzy match"
        : "relative path fuzzy match",
    score: score - relativePath.length / 10_000,
  };
}

async function collectFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [rootPath];
  while (stack.length > 0 && results.length < SEARCH_MAX_FILES) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          stack.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile()) {
        results.push(toRelativePath(rootPath, absolutePath));
      }
    }
  }
  return results;
}

export async function searchPreviewFiles(params: {
  projectId: string;
  projectPath: string | null | undefined;
  query: string;
  limit?: number;
}): Promise<TerminalPreviewFileSearchResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const query = params.query.trim();
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1), 100);
  const absoluteInput = path.isAbsolute(query);
  if (!query || absoluteInput) {
    return {
      kind: "file-search",
      projectId: params.projectId,
      projectPath,
      query,
      absoluteInput,
      items: [],
    };
  }

  const rootPath = await realpath(projectPath);
  const rankedItems = (await collectFiles(rootPath))
    .flatMap((relativePath) => {
      const ranked = rankFile(query, relativePath);
      return ranked ? [ranked] : [];
    })
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore === 0 ? left.path.localeCompare(right.path) : byScore;
    })
    .slice(0, limit);

  return {
    kind: "file-search",
    projectId: params.projectId,
    projectPath,
    query,
    absoluteInput,
    items: rankedItems,
  };
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { maxBuffer?: number },
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
      timeout: 5_000,
    });
    return result.stdout;
  } catch (error) {
    throw new TerminalPreviewError(
      error instanceof Error ? error.message : "Git command failed",
      400,
    );
  }
}

async function resolveGitContext(projectPath: string): Promise<{
  repoRoot: string;
  projectRelativeToRepo: string;
}> {
  const repoRoot = (await runGit(projectPath, ["rev-parse", "--show-toplevel"])).trim();
  const realProjectPath = await realpath(projectPath);
  const projectRelativeToRepo = toRelativePath(repoRoot, realProjectPath);
  return {
    repoRoot,
    projectRelativeToRepo: projectRelativeToRepo === "." ? "" : projectRelativeToRepo,
  };
}

function stripProjectPrefix(
  repoPath: string,
  projectRelativeToRepo: string,
): string | null {
  const normalizedRepoPath = repoPath.split(path.sep).join("/");
  if (!projectRelativeToRepo) {
    return normalizedRepoPath;
  }
  if (normalizedRepoPath === projectRelativeToRepo) {
    return "";
  }
  const prefix = `${projectRelativeToRepo}/`;
  if (!normalizedRepoPath.startsWith(prefix)) {
    return null;
  }
  return normalizedRepoPath.slice(prefix.length);
}

function toRepoPath(projectRelativeToRepo: string, projectRelativePath: string): string {
  return projectRelativeToRepo
    ? `${projectRelativeToRepo}/${projectRelativePath}`
    : projectRelativePath;
}

function mapGitStatus(code: string): TerminalPreviewGitStatus {
  switch (code) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "?":
      return "untracked";
    default:
      return "unknown";
  }
}

function parseGitStatus(
  output: string,
  projectRelativeToRepo: string,
): Pick<TerminalPreviewGitChangesResponse, "staged" | "working"> {
  const staged = new Map<string, TerminalPreviewChangeFile>();
  const working = new Map<string, TerminalPreviewChangeFile>();
  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }
    const indexStatus = line[0] ?? " ";
    const workingStatus = line[1] ?? " ";
    const rawPath = line.slice(3);
    const repoPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    const projectPath = stripProjectPrefix(repoPath, projectRelativeToRepo);
    if (!projectPath) {
      continue;
    }

    if (indexStatus === "?" && workingStatus === "?") {
      working.set(projectPath, {
        path: projectPath,
        status: "untracked",
      });
      continue;
    }
    if (indexStatus !== " ") {
      staged.set(projectPath, {
        path: projectPath,
        status: mapGitStatus(indexStatus),
      });
    }
    if (workingStatus !== " ") {
      working.set(projectPath, {
        path: projectPath,
        status: mapGitStatus(workingStatus),
      });
    }
  }
  return {
    staged: Array.from(staged.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    working: Array.from(working.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export async function getPreviewGitChanges(params: {
  projectId: string;
  projectPath: string | null | undefined;
}): Promise<TerminalPreviewGitChangesResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);
  const pathspec = projectRelativeToRepo || ".";
  const output = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", pathspec],
    { maxBuffer: 1024 * 1024 },
  );
  const parsed = parseGitStatus(output, projectRelativeToRepo);
  return {
    kind: "git-changes",
    projectId: params.projectId,
    projectPath,
    repoRoot,
    ...parsed,
  };
}

async function readGitBlob(
  repoRoot: string,
  ref: string,
  repoPath: string,
): Promise<string> {
  try {
    const result = await execFileAsync("git", ["show", `${ref}:${repoPath}`], {
      cwd: repoRoot,
      maxBuffer: GIT_FILE_CONTENT_MAX_BYTES,
      timeout: 5_000,
    });
    return result.stdout;
  } catch {
    return "";
  }
}

async function readWorkingFile(absolutePath: string): Promise<string> {
  const stats = await stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile() || stats.size > GIT_FILE_CONTENT_MAX_BYTES) {
    return "";
  }
  const content = await readFile(absolutePath);
  return isLikelyBinary(content) ? "" : content.toString("utf8");
}

function findChangeStatus(
  changes: Pick<TerminalPreviewGitChangesResponse, "staged" | "working">,
  kind: TerminalPreviewChangeKind,
  relativePath: string,
): TerminalPreviewGitStatus {
  return (
    changes[kind].find((change) => change.path === relativePath)?.status ?? "unknown"
  );
}

export async function getPreviewFileDiff(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  changeKind: TerminalPreviewChangeKind;
}): Promise<TerminalPreviewFileDiffResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
  );
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);
  const repoPath = toRepoPath(projectRelativeToRepo, relativePath);
  const pathspec = projectRelativeToRepo || ".";
  const statusOutput = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", pathspec],
    { maxBuffer: 1024 * 1024 },
  );
  const changes = parseGitStatus(statusOutput, projectRelativeToRepo);
  const status = findChangeStatus(changes, params.changeKind, relativePath);
  const oldContent =
    params.changeKind === "staged"
      ? await readGitBlob(repoRoot, "HEAD", repoPath)
      : await readGitBlob(repoRoot, "", repoPath);
  const newContent =
    params.changeKind === "staged"
      ? await readGitBlob(repoRoot, "", repoPath)
      : await readWorkingFile(absolutePath);

  return {
    kind: "file-diff",
    projectId: params.projectId,
    projectPath,
    repoRoot,
    changeKind: params.changeKind,
    path: relativePath,
    status,
    oldContent,
    newContent,
    readonly: true,
  };
}
