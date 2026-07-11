import path from "node:path";
import type { TerminalPreviewChangeFile, TerminalPreviewFileSearchItem, TerminalPreviewFileSearchResponse, TerminalPreviewFolderSearchItem, TerminalPreviewFolderSearchResponse } from "@runweave/shared/terminal/preview";
import { ensureProjectPath } from "./preview-paths";
import { getPreviewGitChanges } from "./preview-git";
import { collectCachedSearchCandidateFiles } from "./preview-search-candidates";

export { clearPreviewFileSearchCache } from "./preview-search-candidates";

const DEFAULT_SEARCH_LIMIT = 50;

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
  if (compactQuery.length > 3) {
    return 0;
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

function rankPathCandidate(query: string, relativePath: string): number {
  const basename = path.posix.basename(relativePath);
  const basenameScore = scoreQueryAgainstCandidate(query, basename);
  const pathScore = scoreQueryAgainstCandidate(query, relativePath);
  const segmentScore = relativePath
    .split("/")
    .reduce(
      (best, segment) => Math.max(best, scoreQueryAgainstCandidate(query, segment)),
      0,
    );

  return Math.max(
    basenameScore > 0 ? basenameScore + 25 : 0,
    pathScore > 0 ? pathScore + pathBoundaryBonus(query, relativePath) : 0,
    segmentScore > 0 ? segmentScore + 10 : 0,
  );
}

function isPathQuery(query: string): boolean {
  return query.includes("/") || query.includes("\\");
}

function rankFileCandidate(query: string, relativePath: string): {
  score: number;
  basenameScore: number;
  pathScore: number;
} {
  const basename = path.posix.basename(relativePath);
  const basenameScore = scoreQueryAgainstCandidate(query, basename);
  const pathScore = isPathQuery(query)
    ? scoreQueryAgainstCandidate(query, relativePath)
    : 0;

  return {
    basenameScore,
    pathScore,
    score: Math.max(
      basenameScore > 0 ? basenameScore + 25 : 0,
      pathScore > 0 ? pathScore + pathBoundaryBonus(query, relativePath) : 0,
    ),
  };
}

function rankFile(
  query: string,
  relativePath: string,
): TerminalPreviewFileSearchItem | null {
  const basename = path.posix.basename(relativePath);
  const dirname = path.posix.dirname(relativePath);
  const normalizedDirname = dirname === "." ? "" : dirname;
  const { basenameScore, pathScore, score } = rankFileCandidate(
    query,
    relativePath,
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

function collectDirectoriesFromFiles(relativePaths: string[]): string[] {
  const directories = new Set<string>();
  for (const relativePath of relativePaths) {
    const segments = relativePath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return Array.from(directories);
}

function rankFolder(
  query: string,
  relativePath: string,
): TerminalPreviewFolderSearchItem | null {
  const score = rankPathCandidate(query, relativePath);
  if (score <= 0) {
    return null;
  }
  const dirname = path.posix.dirname(relativePath);
  return {
    path: relativePath,
    basename: path.posix.basename(relativePath),
    dirname: dirname === "." ? "" : dirname,
    score: score - relativePath.length / 10_000,
  };
}

function isMarkdownPath(filePath: string): boolean {
  return path.posix.extname(filePath).toLowerCase() === ".md";
}

function toChangedFileSearchItem(
  file: TerminalPreviewChangeFile,
): TerminalPreviewFileSearchItem {
  const dirname = path.posix.dirname(file.path);
  return {
    path: file.path,
    basename: path.posix.basename(file.path),
    dirname: dirname === "." ? "" : dirname,
    gitStatus: file.status,
    reason: "git changed file",
    score: 0,
  };
}

function compareChangedFileSearchItems(
  left: TerminalPreviewFileSearchItem,
  right: TerminalPreviewFileSearchItem,
): number {
  const leftMarkdown = isMarkdownPath(left.path);
  const rightMarkdown = isMarkdownPath(right.path);
  if (leftMarkdown !== rightMarkdown) {
    return leftMarkdown ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

async function getChangedFileSearchItems(params: {
  projectId: string;
  projectPath: string;
  limit: number;
}): Promise<TerminalPreviewFileSearchItem[]> {
  try {
    const changes = await getPreviewGitChanges({
      projectId: params.projectId,
      projectPath: params.projectPath,
    });
    const byPath = new Map<string, TerminalPreviewChangeFile>();
    for (const file of [...changes.staged, ...changes.working]) {
      if (!byPath.has(file.path)) {
        byPath.set(file.path, file);
      }
    }
    return Array.from(byPath.values())
      .map(toChangedFileSearchItem)
      .sort(compareChangedFileSearchItems)
      .slice(0, params.limit);
  } catch {
    return [];
  }
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
  if (absoluteInput) {
    return {
      kind: "file-search",
      projectId: params.projectId,
      projectPath,
      query,
      absoluteInput,
      items: [],
    };
  }
  if (!query) {
    return {
      kind: "file-search",
      projectId: params.projectId,
      projectPath,
      query,
      absoluteInput,
      items: await getChangedFileSearchItems({
        projectId: params.projectId,
        projectPath,
        limit,
      }),
    };
  }

  const rankedItems = (await collectCachedSearchCandidateFiles(params.projectId, projectPath))
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

export async function searchPreviewFolders(params: {
  projectId: string;
  projectPath: string | null | undefined;
  query: string;
  limit?: number;
}): Promise<TerminalPreviewFolderSearchResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const query = params.query.trim();
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1), 100);
  if (!query || path.isAbsolute(query)) {
    return {
      kind: "folder-search",
      projectId: params.projectId,
      projectPath,
      query,
      items: [],
      truncated: false,
    };
  }

  const rankedItems = collectDirectoriesFromFiles(
    await collectCachedSearchCandidateFiles(params.projectId, projectPath),
  )
    .flatMap((relativePath) => {
      const ranked = rankFolder(query, relativePath);
      return ranked ? [ranked] : [];
    })
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore === 0 ? left.path.localeCompare(right.path) : byScore;
    });

  return {
    kind: "folder-search",
    projectId: params.projectId,
    projectPath,
    query,
    items: rankedItems.slice(0, limit),
    truncated: rankedItems.length > limit,
  };
}
