import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TerminalPreviewContentSearchItem, TerminalPreviewContentSearchRange, TerminalPreviewContentSearchResponse } from "@runweave/shared/terminal/preview";
import { logger } from "../../logging";
import { ensureProjectPath, TerminalPreviewError } from "./paths";
import {
  buildRgSearchExclusionArgs,
  collectCachedSearchCandidateFiles,
  shouldIncludeSearchCandidate,
} from "./search-candidates";

const DEFAULT_CONTENT_SEARCH_LIMIT = 50;
const CONTENT_SEARCH_TIMEOUT_MS = 15_000;
const CONTENT_SEARCH_SNIPPET_RADIUS = 80;
const CONTENT_SEARCH_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 5;
const CONTENT_SEARCH_MAX_STDERR_LENGTH = 16_384;
const terminalPreviewLogger = logger.child({ component: "terminal-preview" });

interface ContentSearchExecution {
  items: TerminalPreviewContentSearchItem[];
  truncated: boolean;
}

function normalizeRgPath(filePath: string): string {
  return filePath
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "");
}

function createSnippet(params: {
  lineText: string;
  ranges: TerminalPreviewContentSearchRange[];
}): { lineText: string; ranges: TerminalPreviewContentSearchRange[] } {
  const firstRange = params.ranges[0];
  if (!firstRange || params.lineText.length <= CONTENT_SEARCH_SNIPPET_RADIUS * 2) {
    return {
      lineText: params.lineText.trimEnd(),
      ranges: params.ranges,
    };
  }

  const start = Math.max(0, firstRange.start - CONTENT_SEARCH_SNIPPET_RADIUS);
  const end = Math.min(
    params.lineText.length,
    firstRange.end + CONTENT_SEARCH_SNIPPET_RADIUS,
  );
  const prefix = start > 0 ? "..." : "";
  const suffix = end < params.lineText.length ? "..." : "";
  const offset = start - prefix.length;
  return {
    lineText: `${prefix}${params.lineText.slice(start, end).trimEnd()}${suffix}`,
    ranges: params.ranges
      .filter((range) => range.end >= start && range.start <= end)
      .map((range) => ({
        start: Math.max(0, range.start - offset),
        end: Math.max(0, range.end - offset),
      })),
  };
}

function parseRgMatch(params: {
  filePath: string;
  matchRecord: string;
  query: string;
}): TerminalPreviewContentSearchItem | null {
  const relativePath = normalizeRgPath(params.filePath);
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  if (!shouldIncludeSearchCandidate(relativePath)) {
    return null;
  }

  const lineSeparator = params.matchRecord.indexOf(":");
  const columnSeparator = params.matchRecord.indexOf(":", lineSeparator + 1);
  if (lineSeparator <= 0 || columnSeparator <= lineSeparator + 1) {
    return null;
  }
  const lineNumber = Number(params.matchRecord.slice(0, lineSeparator));
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    return null;
  }
  const rawLineText = params.matchRecord
    .slice(columnSeparator + 1)
    .replace(/\r$/, "");
  const ranges = findLiteralRanges({
    lineText: rawLineText,
    query: params.query,
    caseSensitive: shouldSearchCaseSensitively(params.query),
  });
  const firstRange = ranges[0];
  const dirname = path.posix.dirname(relativePath);
  const snippet = createSnippet({
    lineText: rawLineText,
    ranges,
  });

  return {
    path: relativePath,
    basename: path.posix.basename(relativePath),
    dirname: dirname === "." ? "" : dirname,
    line: lineNumber,
    column: firstRange ? firstRange.start + 1 : 1,
    lineText: snippet.lineText,
    ranges: snippet.ranges,
  };
}

function buildRgContentArgs(query: string): string[] {
  return [
    "--line-number",
    "--column",
    "--with-filename",
    "--null",
    "--no-heading",
    "--color",
    "never",
    "--smart-case",
    "--fixed-strings",
    "--no-config",
    "--no-require-git",
    "--no-messages",
    "--hidden",
    "--max-count",
    "5",
    "--max-filesize",
    "1M",
    ...buildRgSearchExclusionArgs(),
    "--",
    query,
    ".",
  ];
}

function isMissingRipgrepError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

function createAbortError(): Error {
  const error = new Error("Content search aborted");
  error.name = "AbortError";
  return error;
}

function throwIfSearchStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function toContentSearchError(error: unknown): TerminalPreviewError {
  if (error instanceof TerminalPreviewError) {
    return error;
  }
  if (error instanceof Error) {
    const details = error as Error & {
      code?: string | number;
      signal?: string;
      killed?: boolean;
    };
    if (details.code === "ENOENT") {
      return new TerminalPreviewError("Content search requires ripgrep", 503);
    }
    if (
      details.killed ||
      details.signal ||
      details.code === "ETIMEDOUT"
    ) {
      return new TerminalPreviewError("Content search timed out", 504);
    }
    if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return new TerminalPreviewError("Content search returned too much data", 413);
    }
  }
  return new TerminalPreviewError("Content search failed", 500);
}

function shouldSearchCaseSensitively(query: string): boolean {
  return query !== query.toLowerCase();
}

function findLiteralRanges(params: {
  lineText: string;
  query: string;
  caseSensitive: boolean;
}): TerminalPreviewContentSearchRange[] {
  const haystack = params.caseSensitive
    ? params.lineText
    : params.lineText.toLowerCase();
  const needle = params.caseSensitive ? params.query : params.query.toLowerCase();
  const ranges: TerminalPreviewContentSearchRange[] = [];
  let cursor = 0;
  while (cursor <= haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      break;
    }
    ranges.push({
      start: index,
      end: index + needle.length,
    });
    cursor = Math.max(index + needle.length, index + 1);
  }
  return ranges;
}

function searchContentWithRipgrep(params: {
  projectPath: string;
  query: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<ContentSearchExecution> {
  throwIfSearchStopped(params.signal);

  return new Promise((resolve, reject) => {
    const child = spawn("rg", buildRgContentArgs(params.query), {
      cwd: params.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const items: TerminalPreviewContentSearchItem[] = [];
    let outputBuffer = "";
    let pendingPath: string | null = null;
    let stderr = "";
    let settled = false;
    let stoppedForLimit = false;
    let timedOut = false;
    let aborted = false;

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (result: ContentSearchExecution): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stopChild = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    };
    const parseAvailableRecords = (): void => {
      while (!stoppedForLimit) {
        if (pendingPath === null) {
          const pathEnd = outputBuffer.indexOf("\0");
          if (pathEnd < 0) return;
          pendingPath = outputBuffer.slice(0, pathEnd);
          outputBuffer = outputBuffer.slice(pathEnd + 1);
        }

        const recordEnd = outputBuffer.indexOf("\n");
        if (recordEnd < 0) return;
        const matchRecord = outputBuffer.slice(0, recordEnd);
        outputBuffer = outputBuffer.slice(recordEnd + 1);
        const item = parseRgMatch({
          filePath: pendingPath,
          matchRecord,
          query: params.query,
        });
        pendingPath = null;
        if (!item) continue;
        items.push(item);
        if (items.length > params.limit) {
          stoppedForLimit = true;
          stopChild();
        }
      }
    };
    const handleAbort = (): void => {
      aborted = true;
      stopChild();
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, CONTENT_SEARCH_TIMEOUT_MS);

    params.signal?.addEventListener("abort", handleAbort, { once: true });
    if (params.signal?.aborted) {
      handleAbort();
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBuffer += chunk;
      parseAvailableRecords();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < CONTENT_SEARCH_MAX_STDERR_LENGTH) {
        stderr += chunk.slice(0, CONTENT_SEARCH_MAX_STDERR_LENGTH - stderr.length);
      }
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (aborted) {
        fail(createAbortError());
        return;
      }
      if (timedOut) {
        fail(new TerminalPreviewError("Content search timed out", 504));
        return;
      }
      if (stoppedForLimit || code === 0 || code === 1) {
        finish({
          items: items.slice(0, params.limit),
          truncated: stoppedForLimit,
        });
        return;
      }
      fail(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
    });
  });
}

async function readSearchableTextFile(
  projectPath: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfSearchStopped(signal);
  const absolutePath = path.join(projectPath, relativePath);
  const fileStats = await stat(absolutePath).catch(() => null);
  throwIfSearchStopped(signal);
  if (
    !fileStats?.isFile() ||
    fileStats.size > CONTENT_SEARCH_MAX_FILE_SIZE_BYTES
  ) {
    return null;
  }
  const buffer = await readFile(absolutePath, { signal }).catch(() => {
    throwIfSearchStopped(signal);
    return null;
  });
  if (!buffer) return null;
  if (buffer.includes(0)) {
    return null;
  }
  return buffer.toString("utf8");
}

async function searchContentWithNodeFallback(params: {
  projectPath: string;
  query: string;
  limit: number;
  relativePaths: string[];
  signal?: AbortSignal;
}): Promise<ContentSearchExecution> {
  const items: TerminalPreviewContentSearchItem[] = [];
  const caseSensitive = shouldSearchCaseSensitively(params.query);
  const deadline = performance.now() + CONTENT_SEARCH_TIMEOUT_MS;
  for (const relativePath of params.relativePaths) {
    throwIfSearchStopped(params.signal);
    if (performance.now() > deadline) {
      throw new TerminalPreviewError("Content search timed out", 504);
    }
    if (items.length > params.limit) {
      break;
    }
    const content = await readSearchableTextFile(
      params.projectPath,
      relativePath,
      params.signal,
    );
    if (content === null) {
      continue;
    }
    let fileMatchCount = 0;
    const lines = content.split(/\r?\n/g);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLineText = lines[lineIndex] ?? "";
      const ranges = findLiteralRanges({
        lineText: rawLineText,
        query: params.query,
        caseSensitive,
      });
      if (ranges.length === 0) {
        continue;
      }
      const firstRange = ranges[0];
      const dirname = path.posix.dirname(relativePath);
      const snippet = createSnippet({
        lineText: rawLineText,
        ranges,
      });
      items.push({
        path: relativePath,
        basename: path.posix.basename(relativePath),
        dirname: dirname === "." ? "" : dirname,
        line: lineIndex + 1,
        column: firstRange ? firstRange.start + 1 : 1,
        lineText: snippet.lineText,
        ranges: snippet.ranges,
      });
      fileMatchCount += 1;
      if (
        fileMatchCount >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE ||
        items.length > params.limit
      ) {
        break;
      }
    }
  }
  return {
    items: items.slice(0, params.limit),
    truncated: items.length > params.limit,
  };
}

export async function searchPreviewContent(params: {
  projectId: string;
  projectPath: string | null | undefined;
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<TerminalPreviewContentSearchResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const query = params.query.trim();
  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_CONTENT_SEARCH_LIMIT, 1),
    100,
  );
  if (!query) {
    return {
      kind: "content-search",
      projectId: params.projectId,
      projectPath,
      query,
      items: [],
      truncated: false,
    };
  }

  const startedAt = performance.now();
  let execution: ContentSearchExecution;
  try {
    execution = await searchContentWithRipgrep({
      projectPath,
      query,
      limit,
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    if (!isMissingRipgrepError(error)) {
      throw toContentSearchError(error);
    }
    const candidateFiles = await collectCachedSearchCandidateFiles(
      params.projectId,
      projectPath,
    );
    execution = await searchContentWithNodeFallback({
      projectPath,
      query,
      limit,
      relativePaths: candidateFiles,
      signal: params.signal,
    });
  }
  terminalPreviewLogger.debug("terminal-preview.content-search.completed", {
    message: "Terminal preview content search completed",
    projectPath,
    queryLength: query.length,
    resultCount: execution.items.length,
    truncated: execution.truncated,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return {
    kind: "content-search",
    projectId: params.projectId,
    projectPath,
    query,
    items: execution.items,
    truncated: execution.truncated,
  };
}
