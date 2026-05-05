import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewGitStatus,
} from "@browser-viewer/shared";
import {
  TerminalPreviewError,
  ensureProjectPath,
  isLikelyBinary,
  resolvePreviewPath,
  toRelativePath,
} from "./preview-paths";

const execFileAsync = promisify(execFile);
const GIT_FILE_CONTENT_MAX_BYTES = 1024 * 1024;

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
