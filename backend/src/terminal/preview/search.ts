import path from "node:path";
import type { TerminalPreviewChangeFile, TerminalPreviewFileSearchItem, TerminalPreviewFileSearchResponse, TerminalPreviewFolderSearchItem, TerminalPreviewFolderSearchResponse } from "@runweave/shared/terminal/preview";
import { ensureProjectPath } from "./paths";
import { getPreviewGitChanges } from "./git";
import { collectCachedSearchCandidateFiles } from "./search-candidates";

export { clearPreviewFileSearchCache } from "./search-candidates";

const DEFAULT_SEARCH_LIMIT = 50;

interface PreparedFileSearchCandidate {
  relativePath: string;
  basename: string;
  compactBasename: string;
  compactPath: string;
}

interface PreparedFileSearchQuery {
  compactQuery: string;
  pieces: string[];
}

interface PreparedFolderSearchCandidate {
  relativePath: string;
  basename: string;
  compactBasename: string;
  compactPath: string;
  compactSegments: string[];
}

const preparedFileCandidateCache = new WeakMap<
  string[],
  PreparedFileSearchCandidate[]
>();
const preparedFolderCandidateCache = new WeakMap<
  string[],
  PreparedFolderSearchCandidate[]
>();

function compactText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function fuzzyScoreCompacted(
  compactQuery: string,
  compactCandidate: string,
): number {
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

function prepareFileSearchQuery(query: string): PreparedFileSearchQuery {
  return {
    compactQuery: compactText(query),
    pieces: splitQueryPieces(query).map(compactText).filter(Boolean),
  };
}

function scorePreparedQueryAgainstCandidate(
  query: PreparedFileSearchQuery,
  compactCandidate: string,
): number {
  if (query.pieces.length <= 1) {
    return fuzzyScoreCompacted(query.pieces[0] ?? "", compactCandidate);
  }

  let total = 0;
  for (const piece of query.pieces) {
    const pieceScore = fuzzyScoreCompacted(piece, compactCandidate);
    if (pieceScore <= 0) return 0;
    total += pieceScore;
  }
  return total / query.pieces.length;
}

function preparedPathBoundaryBonus(
  compactQuery: string,
  compactPath: string,
): number {
  if (!compactQuery) return 0;
  if (compactPath === compactQuery) return 45;
  return compactPath.endsWith(compactQuery) ? 30 : 0;
}

function getPreparedFileCandidates(
  relativePaths: string[],
): PreparedFileSearchCandidate[] {
  const cached = preparedFileCandidateCache.get(relativePaths);
  if (cached) return cached;
  const prepared = relativePaths.map((relativePath) => {
    const basename = path.posix.basename(relativePath);
    return {
      relativePath,
      basename,
      compactBasename: compactText(basename),
      compactPath: compactText(relativePath),
    };
  });
  preparedFileCandidateCache.set(relativePaths, prepared);
  return prepared;
}

function rankFileCandidate(
  query: PreparedFileSearchQuery,
  candidate: PreparedFileSearchCandidate,
): {
  score: number;
  basenameScore: number;
  pathScore: number;
} {
  const basenameScore = scorePreparedQueryAgainstCandidate(
    query,
    candidate.compactBasename,
  );
  const pathScore = scorePreparedQueryAgainstCandidate(
    query,
    candidate.compactPath,
  );

  return {
    basenameScore,
    pathScore,
    score: Math.max(
      basenameScore > 0 ? basenameScore + 25 : 0,
      pathScore > 0
        ? pathScore +
            preparedPathBoundaryBonus(query.compactQuery, candidate.compactPath)
        : 0,
    ),
  };
}

function rankFile(
  query: PreparedFileSearchQuery,
  candidate: PreparedFileSearchCandidate,
): TerminalPreviewFileSearchItem | null {
  const { basename, relativePath } = candidate;
  const dirname = path.posix.dirname(relativePath);
  const normalizedDirname = dirname === "." ? "" : dirname;
  const { basenameScore, pathScore, score } = rankFileCandidate(
    query,
    candidate,
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

function getPreparedFolderCandidates(
  relativePaths: string[],
): PreparedFolderSearchCandidate[] {
  const cached = preparedFolderCandidateCache.get(relativePaths);
  if (cached) return cached;
  const prepared = collectDirectoriesFromFiles(relativePaths).map(
    (relativePath) => {
      const segments = relativePath.split("/").filter(Boolean);
      const basename = path.posix.basename(relativePath);
      return {
        relativePath,
        basename,
        compactBasename: compactText(basename),
        compactPath: compactText(relativePath),
        compactSegments: segments.map(compactText),
      };
    },
  );
  preparedFolderCandidateCache.set(relativePaths, prepared);
  return prepared;
}

function rankFolder(
  query: PreparedFileSearchQuery,
  candidate: PreparedFolderSearchCandidate,
): TerminalPreviewFolderSearchItem | null {
  const basenameScore = scorePreparedQueryAgainstCandidate(
    query,
    candidate.compactBasename,
  );
  const pathScore = scorePreparedQueryAgainstCandidate(
    query,
    candidate.compactPath,
  );
  const segmentScore = candidate.compactSegments.reduce(
    (best, segment) =>
      Math.max(best, scorePreparedQueryAgainstCandidate(query, segment)),
    0,
  );
  const score = Math.max(
    basenameScore > 0 ? basenameScore + 25 : 0,
    pathScore > 0
      ? pathScore +
          preparedPathBoundaryBonus(query.compactQuery, candidate.compactPath)
      : 0,
    segmentScore > 0 ? segmentScore + 10 : 0,
  );
  if (score <= 0) {
    return null;
  }
  const dirname = path.posix.dirname(candidate.relativePath);
  return {
    path: candidate.relativePath,
    basename: candidate.basename,
    dirname: dirname === "." ? "" : dirname,
    score: score - candidate.relativePath.length / 10_000,
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
}): Promise<TerminalPreviewFileSearchItem[]> {
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
    .sort(compareChangedFileSearchItems);
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
      truncated: false,
    };
  }
  if (!query) {
    const changedItems = await getChangedFileSearchItems({
      projectId: params.projectId,
      projectPath,
    });
    return {
      kind: "file-search",
      projectId: params.projectId,
      projectPath,
      query,
      absoluteInput,
      items: changedItems.slice(0, limit),
      truncated: changedItems.length > limit,
    };
  }

  const candidatePaths = await collectCachedSearchCandidateFiles(
    params.projectId,
    projectPath,
  );
  const preparedQuery = prepareFileSearchQuery(query);
  const rankedItems = getPreparedFileCandidates(candidatePaths)
    .flatMap((candidate) => {
      const ranked = rankFile(preparedQuery, candidate);
      return ranked ? [ranked] : [];
    })
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore === 0 ? left.path.localeCompare(right.path) : byScore;
    });

  return {
    kind: "file-search",
    projectId: params.projectId,
    projectPath,
    query,
    absoluteInput,
    items: rankedItems.slice(0, limit),
    truncated: rankedItems.length > limit,
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

  const candidatePaths = await collectCachedSearchCandidateFiles(
    params.projectId,
    projectPath,
  );
  const preparedQuery = prepareFileSearchQuery(query);
  const rankedItems = getPreparedFolderCandidates(candidatePaths)
    .flatMap((candidate) => {
      const ranked = rankFolder(preparedQuery, candidate);
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
