import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../../logging/index";
import { TerminalPreviewError, toRelativePath } from "./paths";

const execFileAsync = promisify(execFile);
const terminalPreviewLogger = logger.child({ component: "terminal-preview" });

const RG_SEARCH_TIMEOUT_MS = 15_000;
const RG_SEARCH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
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
export const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  ".worktree",
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
export const EXCLUDED_FILE_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const EXCLUDED_FILE_SUFFIXES = [".code-search"];

interface FileSearchCacheEntry {
  files: string[];
}

interface FileSearchInflightEntry {
  generation: string;
  promise: Promise<string[]>;
}

export interface PreviewGitignoreRule {
  pattern: string;
  anchored: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  negated: boolean;
}

const fileSearchCandidateCache = new Map<string, FileSearchCacheEntry>();
const fileSearchCandidateInflight = new Map<
  string,
  FileSearchInflightEntry
>();
const fileSearchCandidateGenerations = new Map<string, number>();
let fileSearchCandidateGlobalGeneration = 0;

function parseGitignoreRule(line: string): PreviewGitignoreRule | null {
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

export async function loadPreviewGitignoreRules(
  rootPath: string,
): Promise<PreviewGitignoreRule[]> {
  const content = await readFile(path.join(rootPath, ".gitignore"), "utf8").catch(
    () => null,
  );
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n/g)
    .map(parseGitignoreRule)
    .filter((rule): rule is PreviewGitignoreRule => rule !== null);
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
  rule: PreviewGitignoreRule,
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

export function isIgnoredByPreviewGitignore(
  relativePath: string,
  isDirectory: boolean,
  rules: PreviewGitignoreRule[],
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
  const gitignoreRules = await loadPreviewGitignoreRules(rootPath);
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
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
          !isIgnoredByPreviewGitignore(relativePath, true, gitignoreRules)
        ) {
          stack.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile()) {
        if (!isIgnoredByPreviewGitignore(relativePath, false, gitignoreRules)) {
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

export function buildRgSearchExclusionArgs(): string[] {
  const args: string[] = [];
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

function buildRgFileArgs(): string[] {
  const args = [
    "--files",
    "--hidden",
    "--case-sensitive",
    "--no-require-git",
    "--no-config",
  ];

  args.push(...buildRgSearchExclusionArgs());

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

export function shouldIncludeSearchCandidate(relativePath: string): boolean {
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
    .sort((left, right) => left.localeCompare(right));
}

async function collectFilesWithRipgrep(rootPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("rg", buildRgFileArgs(), {
    cwd: rootPath,
    maxBuffer: RG_SEARCH_MAX_BUFFER_BYTES,
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

function isMissingRipgrepError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

function isEmptyRipgrepResult(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 1
  );
}

function toSearchIndexError(error: unknown): TerminalPreviewError {
  if (error instanceof Error) {
    const details = error as Error & {
      code?: string;
      signal?: string;
      killed?: boolean;
    };
    if (
      details.killed ||
      details.signal ||
      details.code === "ETIMEDOUT"
    ) {
      return new TerminalPreviewError("Project file indexing timed out", 504);
    }
    if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return new TerminalPreviewError("Project file index is too large", 413);
    }
  }
  return new TerminalPreviewError("Project file indexing failed", 500);
}

async function collectSearchCandidateFiles(rootPath: string): Promise<string[]> {
  try {
    return await collectFilesWithRipgrep(rootPath);
  } catch (error) {
    if (isEmptyRipgrepResult(error)) return [];
    if (isMissingRipgrepError(error)) {
      return (await collectFiles(rootPath))
        .filter(shouldIncludeSearchCandidate)
        .sort((left, right) => left.localeCompare(right));
    }
    if (shouldWarnRipgrepFailure(error)) {
      const describedError = describeRipgrepFailure(error);
      terminalPreviewLogger.warn(
        describedError.includes("ETIMEDOUT") || describedError.includes("killed=true")
          ? "terminal-preview.search.timeout"
          : "terminal-preview.search.rg-fallback",
        {
          message: "Preview rg file search failed; falling back",
          rootPath,
          error: describedError,
        },
      );
    }
    throw toSearchIndexError(error);
  }
}

function getFileSearchCacheKey(projectId: string, rootPath: string): string {
  return `${projectId}:${rootPath}`;
}

function readFileSearchCache(cacheKey: string): string[] | null {
  const cached = fileSearchCandidateCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  return cached.files;
}

function writeFileSearchCache(cacheKey: string, files: string[]): void {
  fileSearchCandidateCache.set(cacheKey, { files });
}

function getFileSearchGeneration(cacheKey: string): string {
  return `${fileSearchCandidateGlobalGeneration}:${fileSearchCandidateGenerations.get(cacheKey) ?? 0}`;
}

function invalidateFileSearchCacheKey(cacheKey: string): void {
  fileSearchCandidateGenerations.set(
    cacheKey,
    (fileSearchCandidateGenerations.get(cacheKey) ?? 0) + 1,
  );
  fileSearchCandidateCache.delete(cacheKey);
  fileSearchCandidateInflight.delete(cacheKey);
}

export function clearPreviewFileSearchCache(projectId?: string): void {
  if (!projectId) {
    fileSearchCandidateGlobalGeneration += 1;
    fileSearchCandidateCache.clear();
    fileSearchCandidateInflight.clear();
    fileSearchCandidateGenerations.clear();
    return;
  }

  const cacheKeys = new Set([
    ...fileSearchCandidateCache.keys(),
    ...fileSearchCandidateInflight.keys(),
    ...fileSearchCandidateGenerations.keys(),
  ]);
  for (const cacheKey of cacheKeys) {
    if (cacheKey.startsWith(`${projectId}:`)) {
      invalidateFileSearchCacheKey(cacheKey);
    }
  }
}

async function collectCachedSearchCandidateRootFiles(
  projectId: string,
  rootPath: string,
): Promise<string[]> {
  const cacheKey = getFileSearchCacheKey(projectId, rootPath);
  const cached = readFileSearchCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const generation = getFileSearchGeneration(cacheKey);
  const inflight = fileSearchCandidateInflight.get(cacheKey);
  if (inflight?.generation === generation) {
    return inflight.promise;
  }

  const startedAt = performance.now();
  const pending = collectSearchCandidateFiles(rootPath)
    .then((files) => {
      if (getFileSearchGeneration(cacheKey) === generation) {
        writeFileSearchCache(cacheKey, files);
      }
      terminalPreviewLogger.debug("terminal-preview.search-index.built", {
        message: "Terminal preview search index built",
        rootPath,
        fileCount: files.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return files;
    })
    .finally(() => {
      if (fileSearchCandidateInflight.get(cacheKey)?.promise === pending) {
        fileSearchCandidateInflight.delete(cacheKey);
      }
    });
  fileSearchCandidateInflight.set(cacheKey, { generation, promise: pending });
  return pending;
}

export async function collectCachedSearchCandidateFiles(
  projectId: string,
  projectPath: string,
): Promise<string[]> {
  return collectCachedSearchCandidateRootFiles(projectId, await realpath(projectPath));
}
