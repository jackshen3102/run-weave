import { readChangeContent } from "./change-content";
import { execFile } from "node:child_process";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TerminalPreviewChangeFile, TerminalPreviewChangeKind, TerminalPreviewFileDiffResponse, TerminalPreviewGitChangesResponse, TerminalPreviewGitStatus, TerminalPreviewResetChangeResponse } from "@runweave/shared/terminal/preview";
import {
  TerminalPreviewError,
  ensureProjectPath,
  toRelativePath,
} from "./paths";

const execFileAsync = promisify(execFile);


class GitRepositoryMissingError extends TerminalPreviewError {
  constructor() {
    super("This project is not a Git repository.", 400);
  }
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
      env: { ...process.env, LC_ALL: "C", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.stdout;
  } catch (error) {
    if (
      args[0] === "rev-parse" &&
      error instanceof Error &&
      "code" in error &&
      error.code === 128 &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.startsWith(
        "fatal: not a git repository (or any of the parent directories)",
      )
    ) {
      throw new GitRepositoryMissingError();
    }
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
  const repoRoot = (
    await runGit(projectPath, ["rev-parse", "--show-toplevel"])
  ).trim();
  const realProjectPath = await realpath(projectPath);
  const projectRelativeToRepo = toRelativePath(repoRoot, realProjectPath);
  return {
    repoRoot,
    projectRelativeToRepo:
      projectRelativeToRepo === "." ? "" : projectRelativeToRepo,
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

function toRepoPath(
  projectRelativeToRepo: string,
  projectRelativePath: string,
): string {
  return projectRelativeToRepo
    ? `${projectRelativeToRepo}/${projectRelativePath}`
    : projectRelativePath;
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function resolvePreviewGitPath(
  projectPath: string,
  requestedPath: string,
): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
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
  if (!isInsidePath(rootPath, candidatePath)) {
    throw new TerminalPreviewError("Path is outside the project path", 403);
  }

  return {
    absolutePath: candidatePath,
    relativePath: toRelativePath(rootPath, candidatePath),
  };
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
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const indexStatus = record[0] ?? " ";
    const workingStatus = record[1] ?? " ";
    const repoPath = record.slice(3);
    let originalPath: string | undefined;
    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      workingStatus === "R" ||
      workingStatus === "C"
    ) {
      originalPath = stripProjectPrefix(records[++index] ?? "", projectRelativeToRepo) ?? undefined;
    }
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
        ...(["R", "C"].includes(indexStatus) ? { oldPath: originalPath } : {}),
      });
    }
    if (workingStatus !== " ") {
      working.set(projectPath, {
        path: projectPath,
        status: mapGitStatus(workingStatus),
        ...(["R", "C"].includes(workingStatus) ? { oldPath: originalPath } : {}),
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
  let context;
  try {
    context = await resolveGitContext(projectPath);
  } catch (error) {
    if (!(error instanceof GitRepositoryMissingError)) throw error;
    return {
      kind: "git-changes",
      projectId: params.projectId,
      projectPath,
      repoRoot: null,
      staged: [],
      working: [],
    };
  }
  const { repoRoot, projectRelativeToRepo } = context;
  const pathspec = projectRelativeToRepo || ".";
  const output = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", pathspec],
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

export async function resetPreviewGitChange(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  changeKind: TerminalPreviewChangeKind;
}): Promise<TerminalPreviewResetChangeResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewGitPath(
    projectPath,
    params.requestedPath,
  );
  const { repoRoot, projectRelativeToRepo } =
    await resolveGitContext(projectPath);
  const repoPath = toRepoPath(projectRelativeToRepo, relativePath);
  const statusOutput = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", repoPath],
    { maxBuffer: 1024 * 1024 },
  );
  const changes = parseGitStatus(statusOutput, projectRelativeToRepo);
  const change = changes[params.changeKind].find(
    (entry) => entry.path === relativePath,
  );
  if (!change) {
    throw new TerminalPreviewError("No selected change to reset", 409);
  }

  if (params.changeKind === "staged") {
    await runGit(repoRoot, ["restore", "--staged", "--", repoPath]);
  } else if (change.status === "untracked") {
    const fileStats = await lstat(absolutePath).catch(() => null);
    if (!fileStats) {
      throw new TerminalPreviewError("File not found", 404);
    }
    if (fileStats.isDirectory() && !fileStats.isSymbolicLink()) {
      throw new TerminalPreviewError("Directories are not supported", 400);
    }
    if (!fileStats.isFile() && !fileStats.isSymbolicLink()) {
      throw new TerminalPreviewError("Only regular files can be reset", 400);
    }
    await unlink(absolutePath);
  } else {
    await runGit(repoRoot, ["restore", "--worktree", "--", repoPath]);
  }

  return {
    kind: "git-change-reset",
    projectId: params.projectId,
    path: relativePath,
    changeKind: params.changeKind,
  };
}

type ChangeRequest = {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  changeKind: TerminalPreviewChangeKind;
};

async function readComparison(params: ChangeRequest) {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewGitPath(projectPath, params.requestedPath);
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);
  // Preserve rename source paths: a destination-only pathspec loses Git's rename pairing.
  const changes = await getPreviewGitChanges(params);
  const change = changes[params.changeKind].find((entry) => entry.path === relativePath);
  if (!change) throw new TerminalPreviewError("Change no longer exists; refresh the list", 409);
  if (["renamed", "copied"].includes(change.status) && !change.oldPath) {
    throw new TerminalPreviewError("Original path is outside the project", 403);
  }
  const oldPath = change.oldPath ?? relativePath;
  const read = (filePath: string, source: "head" | "index" | "working") => readChangeContent({
    projectPath, repoRoot, repoPath: toRepoPath(projectRelativeToRepo, filePath), filePath, source,
  });
  const [old, next] = await Promise.all([
    read(oldPath, params.changeKind === "staged" ? "head" : "index"),
    read(relativePath, params.changeKind === "staged" ? "index" : "working"),
  ]);
  if (next.side.state === "missing" && change.status !== "deleted") {
    throw new TerminalPreviewError("Change moved; refresh the list", 409);
  }
  if (old.side.state === "missing" && !["added", "untracked"].includes(change.status)) {
    throw new TerminalPreviewError("Original version moved; refresh the list", 409);
  }
  const preferred = change.status === "deleted" ? old : next;
  const textComparable = [old, next].every(({ side }) => side.state === "missing"
    || (side.state === "ready" && side.contentKind === "text"));
  const payload: TerminalPreviewFileDiffResponse = {
    kind: "file-diff", projectId: params.projectId, projectPath, repoRoot,
    changeKind: params.changeKind, path: relativePath, absolutePath, status: change.status,
    oldPath: change.oldPath, oldContent: old.text, newContent: next.text, readonly: true,
    contentKind: preferred.side.contentKind ?? "binary",
    diffState: textComparable ? old.text === next.text ? "unchanged" : "available" : "unavailable",
    oldSide: old.side, newSide: next.side,
  };
  return { payload, old, next };
}

export async function getPreviewFileDiff(params: ChangeRequest): Promise<TerminalPreviewFileDiffResponse> {
  return (await readComparison(params)).payload;
}

export async function readPreviewChangeAsset(params: ChangeRequest & {
  side: "old" | "new"; version: string;
}) {
  const comparison = await readComparison(params);
  const content = params.side === "old" ? comparison.old : comparison.next;
  if (content.side.state === "too-large") throw new TerminalPreviewError("Image exceeds preview limit", 413);
  if (content.side.state === "read-failed") throw new TerminalPreviewError("Unable to read image; retry", 500);
  if (content.side.version !== params.version) throw new TerminalPreviewError("Image changed; reload preview", 409);
  if (content.side.state !== "ready" || content.side.contentKind !== "image" || !content.bytes) {
    throw new TerminalPreviewError("Image format is not supported", 415);
  }
  return { content: content.bytes, mimeType: content.side.mimeType! };
}
