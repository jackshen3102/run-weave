import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TerminalPreviewContentSearchItem, TerminalPreviewContentSearchRange, TerminalPreviewContentSearchResponse } from "@runweave/shared/terminal/preview";
import { ensureProjectPath, TerminalPreviewError } from "./preview-paths";
import {
  buildRgSearchExclusionArgs,
  collectCachedSearchCandidateFiles,
  shouldIncludeSearchCandidate,
} from "./preview-search-candidates";

const execFileAsync = promisify(execFile);

const DEFAULT_CONTENT_SEARCH_LIMIT = 50;
const CONTENT_SEARCH_TIMEOUT_MS = 5_000;
const CONTENT_SEARCH_MAX_BUFFER = 4 * 1024 * 1024;
const CONTENT_SEARCH_SNIPPET_RADIUS = 80;
const CONTENT_SEARCH_FILE_CHUNK_SIZE = 500;
const CONTENT_SEARCH_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 5;

interface RgJsonMatchEvent {
  type: "match";
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{
      start?: number;
      end?: number;
    }>;
  };
}

function isRgJsonMatchEvent(value: unknown): value is RgJsonMatchEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "match"
  );
}

function normalizeRgPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
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

function utf8ByteOffsetToUtf16Index(value: string, byteOffset: number): number {
  const targetOffset = Math.max(0, Math.trunc(byteOffset));
  let currentOffset = 0;
  for (let index = 0; index < value.length;) {
    if (currentOffset >= targetOffset) {
      return index;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      return index;
    }
    const character = String.fromCodePoint(codePoint);
    const nextOffset = currentOffset + Buffer.byteLength(character, "utf8");
    if (nextOffset > targetOffset) {
      return index;
    }
    currentOffset = nextOffset;
    index += character.length;
  }
  return value.length;
}

function parseRgMatchLine(line: string): TerminalPreviewContentSearchItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRgJsonMatchEvent(parsed)) {
    return null;
  }

  const relativePath = normalizeRgPath(parsed.data.path?.text ?? "");
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  if (!shouldIncludeSearchCandidate(relativePath)) {
    return null;
  }

  const lineNumber = parsed.data.line_number;
  if (
    typeof lineNumber !== "number" ||
    !Number.isInteger(lineNumber) ||
    lineNumber < 1
  ) {
    return null;
  }

  const rawLineText = parsed.data.lines?.text ?? "";
  const ranges =
    parsed.data.submatches
      ?.map((submatch) => ({
        start: utf8ByteOffsetToUtf16Index(
          rawLineText,
          submatch.start ?? 0,
        ),
        end: utf8ByteOffsetToUtf16Index(rawLineText, submatch.end ?? 0),
      }))
      .filter((range) => range.end > range.start) ?? [];
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

function buildRgContentArgs(query: string, relativePaths: string[]): string[] {
  return [
    "--json",
    "--line-number",
    "--column",
    "--smart-case",
    "--fixed-strings",
    "--no-config",
    "--no-require-git",
    "--hidden",
    "--max-count",
    "5",
    "--max-filesize",
    "1M",
    ...buildRgSearchExclusionArgs(),
    "--",
    query,
    ...relativePaths,
  ];
}

function isNoMatchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 1
  );
}

function isMissingRipgrepError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

function toContentSearchError(error: unknown): TerminalPreviewError {
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

async function readSearchableTextFile(
  projectPath: string,
  relativePath: string,
): Promise<string | null> {
  const buffer = await readFile(path.join(projectPath, relativePath)).catch(
    () => null,
  );
  if (!buffer || buffer.length > CONTENT_SEARCH_MAX_FILE_SIZE_BYTES) {
    return null;
  }
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
}): Promise<TerminalPreviewContentSearchItem[]> {
  const items: TerminalPreviewContentSearchItem[] = [];
  const caseSensitive = shouldSearchCaseSensitively(params.query);
  for (const relativePath of params.relativePaths) {
    if (items.length > params.limit) {
      break;
    }
    const content = await readSearchableTextFile(
      params.projectPath,
      relativePath,
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
  return items;
}

export async function searchPreviewContent(params: {
  projectId: string;
  projectPath: string | null | undefined;
  query: string;
  limit?: number;
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

  const items: TerminalPreviewContentSearchItem[] = [];
  const candidateFiles = await collectCachedSearchCandidateFiles(
    params.projectId,
    projectPath,
  );
  for (
    let index = 0;
    index < candidateFiles.length && items.length <= limit;
    index += CONTENT_SEARCH_FILE_CHUNK_SIZE
  ) {
    const chunk = candidateFiles.slice(index, index + CONTENT_SEARCH_FILE_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }

    let stdout = "";
    try {
      const result = await execFileAsync("rg", buildRgContentArgs(query, chunk), {
        cwd: projectPath,
        maxBuffer: CONTENT_SEARCH_MAX_BUFFER,
        timeout: CONTENT_SEARCH_TIMEOUT_MS,
      });
      stdout = result.stdout;
    } catch (error) {
      if (isNoMatchError(error)) {
        stdout = "";
      } else if (isMissingRipgrepError(error)) {
        const fallbackItems = await searchContentWithNodeFallback({
          projectPath,
          query,
          limit,
          relativePaths: candidateFiles,
        });
        return {
          kind: "content-search",
          projectId: params.projectId,
          projectPath,
          query,
          items: fallbackItems.slice(0, limit),
          truncated: fallbackItems.length > limit,
        };
      } else {
        throw toContentSearchError(error);
      }
    }

    for (const line of stdout.split(/\r?\n/g)) {
      if (!line.trim()) {
        continue;
      }
      const item = parseRgMatchLine(line);
      if (!item) {
        continue;
      }
      items.push(item);
      if (items.length > limit) {
        break;
      }
    }
  }

  return {
    kind: "content-search",
    projectId: params.projectId,
    projectPath,
    query,
    items: items.slice(0, limit),
    truncated: items.length > limit,
  };
}
