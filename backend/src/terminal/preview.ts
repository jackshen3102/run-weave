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
const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const GIT_FILE_CONTENT_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_FILES = 20_000;
const DEFAULT_SEARCH_LIMIT = 50;
const RG_SEARCH_TIMEOUT_MS = 5_000;
const FILE_SEARCH_CACHE_TTL_MS = 15_000;
const SENSITIVE_FILE_GLOBS = [
  ".env",
  "**/.env",
  ".env.local",
  "**/.env.local",
  ".env.*.local",
  "**/.env.*.local",
  "*secret*",
  "**/*secret*",
  "*secrets*",
  "**/*secrets*",
];
const SAFE_ENV_TEMPLATE_FILES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  "CVS",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "vendor",
]);
const EXCLUDED_FILE_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const EXCLUDED_FILE_SUFFIXES = [".code-search"];

interface FileSearchCacheEntry {
  loadedAt: number;
  files: string[];
}

interface GitignoreRule {
  pattern: string;
  anchored: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  negated: boolean;
}

const fileSearchCandidateCache = new Map<string, FileSearchCacheEntry>();
const fileSearchCandidateInflight = new Map<string, Promise<string[]>>();

export class TerminalPreviewError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface TerminalPreviewAssetResponse {
  kind: "asset";
  projectId: string;
  path: string;
  absolutePath: string;
  base: "project";
  projectPath: string;
  mimeType: string;
  content: Buffer;
  sizeBytes: number;
  cacheControl: "no-store";
  readonly: true;
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

function detectImageMimeType(buffer: Buffer, filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") {
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
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
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
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

export async function readPreviewAsset(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
}): Promise<TerminalPreviewAssetResponse> {
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
  if (fileStats.size > IMAGE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("Image exceeds preview limit", 413);
  }

  const content = await readFile(absolutePath);
  const mimeType = detectImageMimeType(content, relativePath);
  if (!mimeType) {
    throw new TerminalPreviewError("Image format is not supported", 415);
  }

  return {
    kind: "asset",
    projectId: params.projectId,
    path: relativePath,
    absolutePath,
    base: "project",
    projectPath,
    mimeType,
    content,
    sizeBytes: fileStats.size,
    cacheControl: "no-store",
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

function splitQueryPieces(query: string): string[] {
  return query
    .trim()
    .split(/\s+/g)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function scoreQueryAgainstCandidate(query: string, candidate: string): number {
  const pieces = splitQueryPieces(query);
  if (pieces.length <= 1) {
    return fuzzyScore(query, candidate);
  }

  let total = 0;
  for (const piece of pieces) {
    const pieceScore = fuzzyScore(piece, candidate);
    if (pieceScore <= 0) {
      return 0;
    }
    total += pieceScore;
  }

  return total / pieces.length;
}

function pathBoundaryBonus(query: string, relativePath: string): number {
  const compactQuery = compactText(query);
  const compactPath = compactText(relativePath);
  if (!compactQuery) {
    return 0;
  }
  if (compactPath === compactQuery) {
    return 45;
  }
  if (compactPath.endsWith(compactQuery)) {
    return 30;
  }
  return 0;
}

function rankFile(query: string, relativePath: string): TerminalPreviewFileSearchItem | null {
  const basename = path.posix.basename(relativePath);
  const dirname = path.posix.dirname(relativePath);
  const normalizedDirname = dirname === "." ? "" : dirname;
  const basenameScore = scoreQueryAgainstCandidate(query, basename);
  const pathScore = scoreQueryAgainstCandidate(query, relativePath);
  const segmentScore = relativePath
    .split("/")
    .reduce(
      (best, segment) => Math.max(best, scoreQueryAgainstCandidate(query, segment)),
      0,
    );
  const score = Math.max(
    basenameScore > 0 ? basenameScore + 25 : 0,
    pathScore > 0 ? pathScore + pathBoundaryBonus(query, relativePath) : 0,
    segmentScore > 0 ? segmentScore + 10 : 0,
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

function parseGitignoreRule(line: string): GitignoreRule | null {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#")) {
    return null;
  }

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1).trim();
  }
  if (!pattern) {
    return null;
  }

  if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  const anchored = pattern.startsWith("/");
  pattern = pattern.replace(/^\/+/, "");
  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  if (!pattern) {
    return null;
  }

  return {
    pattern,
    anchored,
    directoryOnly,
    hasSlash: anchored || pattern.includes("/"),
    negated,
  };
}

async function loadRootGitignoreRules(rootPath: string): Promise<GitignoreRule[]> {
  const content = await readFile(path.join(rootPath, ".gitignore"), "utf8").catch(
    () => null,
  );
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n/g)
    .map(parseGitignoreRule)
    .filter((rule): rule is GitignoreRule => rule !== null);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function gitignorePatternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (!char) {
      continue;
    }
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function gitignorePatternMatches(pattern: string, candidate: string): boolean {
  return gitignorePatternToRegExp(pattern).test(candidate);
}

function pathOrParentMatchesGitignorePattern(
  pattern: string,
  candidate: string,
): boolean {
  const segments = candidate.split("/").filter(Boolean);
  for (let index = segments.length; index >= 1; index -= 1) {
    if (gitignorePatternMatches(pattern, segments.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
}

function matchesGitignoreRule(
  rule: GitignoreRule,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  if (!rule.hasSlash) {
    const candidateSegments = rule.directoryOnly
      ? isDirectory
        ? segments
        : segments.slice(0, -1)
      : segments;
    return candidateSegments.some((segment) =>
      gitignorePatternMatches(rule.pattern, segment),
    );
  }

  const candidates = rule.anchored
    ? [normalizedPath]
    : segments.map((_, index) => segments.slice(index).join("/"));
  return candidates.some((candidate) =>
    pathOrParentMatchesGitignorePattern(rule.pattern, candidate),
  );
}

function isIgnoredByGitignore(
  relativePath: string,
  isDirectory: boolean,
  rules: GitignoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesGitignoreRule(rule, relativePath, isDirectory)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

async function collectFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  const gitignoreRules = await loadRootGitignoreRules(rootPath);
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
      const relativePath = toRelativePath(rootPath, absolutePath);
      if (entry.isDirectory()) {
        if (
          !EXCLUDED_DIRECTORIES.has(entry.name) &&
          !isIgnoredByGitignore(relativePath, true, gitignoreRules)
        ) {
          stack.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile()) {
        if (!isIgnoredByGitignore(relativePath, false, gitignoreRules)) {
          results.push(relativePath);
        }
      }
    }
  }
  return results;
}

function toRgExcludeGlob(directoryName: string): string {
  return `!**/${directoryName}/**`;
}

function buildRgFileArgs(): string[] {
  const args = [
    "--files",
    "--hidden",
    "--case-sensitive",
    "--no-require-git",
    "--no-config",
  ];

  for (const directoryName of EXCLUDED_DIRECTORIES) {
    args.push("-g", toRgExcludeGlob(directoryName));
  }
  for (const fileBasename of EXCLUDED_FILE_BASENAMES) {
    args.push("-g", `!**/${fileBasename}`);
  }
  for (const fileSuffix of EXCLUDED_FILE_SUFFIXES) {
    args.push("-g", `!**/*${fileSuffix}`);
  }
  for (const sensitiveGlob of SENSITIVE_FILE_GLOBS) {
    args.push("-g", `!${sensitiveGlob}`);
  }

  return args;
}

function isSensitiveSearchPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (SAFE_ENV_TEMPLATE_FILES.has(basename)) {
    return false;
  }
  if (
    basename === ".env" ||
    (basename.startsWith(".env.") && basename.endsWith(".local"))
  ) {
    return true;
  }
  return basename.includes("secret");
}

function shouldIncludeSearchCandidate(relativePath: string): boolean {
  if (isSensitiveSearchPath(relativePath)) {
    return false;
  }
  const basename = path.posix.basename(relativePath);
  if (EXCLUDED_FILE_BASENAMES.has(basename)) {
    return false;
  }
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return false;
  }
  return !relativePath
    .split("/")
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function normalizeRgFileList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((filePath) => filePath.split(path.sep).join("/"))
    .filter((filePath) => !path.isAbsolute(filePath))
    .filter(shouldIncludeSearchCandidate)
    .slice(0, SEARCH_MAX_FILES);
}

async function collectFilesWithRipgrep(rootPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("rg", buildRgFileArgs(), {
    cwd: rootPath,
    maxBuffer: 8 * 1024 * 1024,
    timeout: RG_SEARCH_TIMEOUT_MS,
  });

  return normalizeRgFileList(stdout);
}

function describeRipgrepFailure(error: unknown): string {
  if (error instanceof Error) {
    const errorWithDetails = error as Error & {
      code?: string;
      signal?: string;
      killed?: boolean;
    };
    return [
      error.message,
      errorWithDetails.code ? `code=${errorWithDetails.code}` : null,
      errorWithDetails.signal ? `signal=${errorWithDetails.signal}` : null,
      errorWithDetails.killed ? "killed=true" : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(error);
}

function shouldWarnRipgrepFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }
  const errorWithDetails = error as Error & {
    code?: string;
    signal?: string;
    killed?: boolean;
  };
  if (errorWithDetails.code === "ENOENT") {
    return false;
  }
  return Boolean(
    errorWithDetails.killed ||
      errorWithDetails.signal ||
      errorWithDetails.code === "ETIMEDOUT" ||
      errorWithDetails.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      errorWithDetails.code,
  );
}

async function collectSearchCandidateFiles(rootPath: string): Promise<string[]> {
  try {
    return await collectFilesWithRipgrep(rootPath);
  } catch (error) {
    if (shouldWarnRipgrepFailure(error)) {
      console.warn("[viewer-be] preview rg file search failed; falling back", {
        rootPath,
        error: describeRipgrepFailure(error),
      });
    }
    return (await collectFiles(rootPath)).filter(shouldIncludeSearchCandidate);
  }
}

function getFileSearchCacheKey(projectId: string, rootPath: string): string {
  return `${projectId}:${rootPath}`;
}

function readFileSearchCache(cacheKey: string, now = Date.now()): string[] | null {
  const cached = fileSearchCandidateCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (now - cached.loadedAt > FILE_SEARCH_CACHE_TTL_MS) {
    fileSearchCandidateCache.delete(cacheKey);
    return null;
  }
  return cached.files;
}

function writeFileSearchCache(
  cacheKey: string,
  files: string[],
  now = Date.now(),
): void {
  fileSearchCandidateCache.set(cacheKey, {
    loadedAt: now,
    files,
  });
}

export function clearPreviewFileSearchCache(projectId?: string): void {
  if (!projectId) {
    fileSearchCandidateCache.clear();
    fileSearchCandidateInflight.clear();
    return;
  }

  for (const cacheKey of fileSearchCandidateCache.keys()) {
    if (cacheKey.startsWith(`${projectId}:`)) {
      fileSearchCandidateCache.delete(cacheKey);
    }
  }
  for (const cacheKey of fileSearchCandidateInflight.keys()) {
    if (cacheKey.startsWith(`${projectId}:`)) {
      fileSearchCandidateInflight.delete(cacheKey);
    }
  }
}

async function collectCachedSearchCandidateFiles(
  projectId: string,
  rootPath: string,
): Promise<string[]> {
  const cacheKey = getFileSearchCacheKey(projectId, rootPath);
  const cached = readFileSearchCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const inflight = fileSearchCandidateInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const pending = collectSearchCandidateFiles(rootPath)
    .then((files) => {
      writeFileSearchCache(cacheKey, files);
      return files;
    })
    .finally(() => {
      fileSearchCandidateInflight.delete(cacheKey);
    });
  fileSearchCandidateInflight.set(cacheKey, pending);
  return pending;
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
  const rankedItems = (await collectCachedSearchCandidateFiles(params.projectId, rootPath))
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
