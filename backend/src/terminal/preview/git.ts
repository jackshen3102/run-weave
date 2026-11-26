import { readChangeContent } from "./change-content";
import { resolveReadonlyLocalBaseComparison } from "../git/home-branch-status";
import { execFile } from "node:child_process";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  TerminalPreviewBranchChangesResponse, TerminalPreviewBranchCommitItem, TerminalPreviewBranchCommitsResponse,
  TerminalPreviewChangeFile, TerminalPreviewChangeKind, TerminalPreviewContentSide,
  TerminalPreviewFileDiffResponse, TerminalPreviewGitChangesResponse, TerminalPreviewGitStatus,
  TerminalPreviewResetChangeResponse, TerminalPreviewWritableChangeKind,
} from "@runweave/shared/terminal/preview";
import { TerminalPreviewError, ensureProjectPath, toRelativePath } from "./paths";

const execFileAsync = promisify(execFile);
const BRANCH_COMMITS_LIMIT = 50;

class GitRepositoryMissingError extends TerminalPreviewError {
  constructor() { super("This project is not a Git repository.", 400); }
}

async function runGit(cwd: string, args: string[], options?: { maxBuffer?: number }): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd, maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024, timeout: 5_000,
      env: { ...process.env, LC_ALL: "C", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.stdout;
  } catch (error) {
    if (args[0] === "rev-parse" && error instanceof Error && "code" in error && error.code === 128
      && "stderr" in error && typeof error.stderr === "string"
      && error.stderr.startsWith("fatal: not a git repository (or any of the parent directories)")) {
      throw new GitRepositoryMissingError();
    }
    throw new TerminalPreviewError(error instanceof Error ? error.message : "Git command failed", 400);
  }
}

async function resolveGitContext(projectPath: string) {
  const repoRoot = (await runGit(projectPath, ["rev-parse", "--show-toplevel"])).trim();
  const realProjectPath = await realpath(projectPath);
  const projectRelativeToRepo = toRelativePath(repoRoot, realProjectPath);
  return { repoRoot, projectRelativeToRepo: projectRelativeToRepo === "." ? "" : projectRelativeToRepo };
}

function stripProjectPrefix(repoPath: string, projectRelativeToRepo: string): string | null {
  const normalizedRepoPath = repoPath.split(path.sep).join("/");
  if (!projectRelativeToRepo) return normalizedRepoPath;
  if (normalizedRepoPath === projectRelativeToRepo) return "";
  const prefix = `${projectRelativeToRepo}/`;
  return normalizedRepoPath.startsWith(prefix) ? normalizedRepoPath.slice(prefix.length) : null;
}

function toRepoPath(projectRelativeToRepo: string, projectRelativePath: string): string {
  return projectRelativeToRepo ? `${projectRelativeToRepo}/${projectRelativePath}` : projectRelativePath;
}

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolvePreviewGitPath(projectPath: string, requestedPath: string) {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) throw new TerminalPreviewError("Enter a file path", 400);
  if (trimmedPath.startsWith("~")) throw new TerminalPreviewError("Home paths are not supported", 400);
  const rootPath = await realpath(projectPath);
  const candidatePath = path.isAbsolute(trimmedPath) ? path.resolve(trimmedPath) : path.resolve(rootPath, trimmedPath);
  if (!isInsidePath(rootPath, candidatePath)) {
    throw new TerminalPreviewError("Path is outside the project path", 403);
  }
  return { absolutePath: candidatePath, relativePath: toRelativePath(rootPath, candidatePath) };
}

function mapGitStatus(code: string): TerminalPreviewGitStatus {
  switch (code) {
    case "A": return "added";
    case "C": return "copied";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "?": return "untracked";
    default: return "unknown";
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
    if (!record) continue;
    const indexStatus = record[0] ?? " ";
    const workingStatus = record[1] ?? " ";
    const repoPath = record.slice(3);
    let originalPath: string | undefined;
    if (["R", "C"].includes(indexStatus) || ["R", "C"].includes(workingStatus)) {
      originalPath = stripProjectPrefix(records[++index] ?? "", projectRelativeToRepo) ?? undefined;
    }
    const projectPath = stripProjectPrefix(repoPath, projectRelativeToRepo);
    if (!projectPath) continue;

    if (indexStatus === "?" && workingStatus === "?") {
      working.set(projectPath, { path: projectPath, status: "untracked" });
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
    staged: Array.from(staged.values()).sort((a, b) => a.path.localeCompare(b.path)),
    working: Array.from(working.values()).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function parseNameStatusZ(
  output: string,
  projectRelativeToRepo: string,
): Map<string, TerminalPreviewChangeFile> {
  const files = new Map<string, TerminalPreviewChangeFile>();
  const tokens = output.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const rawStatus = tokens[index++];
    if (!rawStatus) continue;
    const statusCode = rawStatus[0] ?? "";
    const status = mapGitStatus(statusCode);
    if (statusCode === "R" || statusCode === "C") {
      const oldRepoPath = tokens[index++] ?? "";
      const newRepoPath = tokens[index++] ?? "";
      const projectPath = stripProjectPrefix(newRepoPath, projectRelativeToRepo);
      const oldProjectPath = stripProjectPrefix(oldRepoPath, projectRelativeToRepo) ?? undefined;
      if (!projectPath) continue;
      files.set(projectPath, {
        path: projectPath,
        status: oldProjectPath ? status : "added",
        ...(oldProjectPath ? { oldPath: oldProjectPath } : {}),
      });
      continue;
    }
    const repoPath = tokens[index++] ?? "";
    const projectPath = stripProjectPrefix(repoPath, projectRelativeToRepo);
    if (!projectPath) continue;
    files.set(projectPath, { path: projectPath, status });
  }
  return files;
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
  return {
    kind: "git-changes",
    projectId: params.projectId,
    projectPath,
    repoRoot,
    ...parseGitStatus(output, projectRelativeToRepo),
  };
}

export async function getPreviewGitBranchChanges(params: {
  projectId: string;
  projectPath: string | null | undefined;
  mainBranch?: string | null;
}): Promise<TerminalPreviewBranchChangesResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const comparison = await resolveReadonlyLocalBaseComparison(
    projectPath,
    params.mainBranch ?? null,
  );
  if (comparison.state !== "ready") {
    return {
      kind: "git-branch-changes",
      projectId: params.projectId,
      projectPath,
      repoRoot: comparison.repoRoot,
      state: "unavailable",
      reason: comparison.reason,
      files: [],
    };
  }
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);
  const pathspec = projectRelativeToRepo || ".";
  const [diffOutput, untrackedOutput] = await Promise.all([
    runGit(
      repoRoot,
      ["diff", "--name-status", "-z", "-M", "--end-of-options", comparison.mergeBaseOid, "--", pathspec],
      { maxBuffer: 2 * 1024 * 1024 },
    ),
    runGit(
      repoRoot,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec],
      { maxBuffer: 1024 * 1024 },
    ),
  ]);
  const filesMap = parseNameStatusZ(diffOutput, projectRelativeToRepo);
  for (const repoPath of untrackedOutput.split("\0")) {
    if (!repoPath) continue;
    const untrackedPath = stripProjectPrefix(repoPath, projectRelativeToRepo);
    if (untrackedPath && !filesMap.has(untrackedPath)) {
      filesMap.set(untrackedPath, { path: untrackedPath, status: "untracked" });
    }
  }
  return {
    kind: "git-branch-changes",
    projectId: params.projectId,
    projectPath,
    repoRoot,
    state: "ready",
    baseRef: comparison.baseRef,
    baseOid: comparison.baseOid,
    mergeBaseOid: comparison.mergeBaseOid,
    headOid: comparison.headOid,
    files: Array.from(filesMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function listBranchCommitItems(
  repoRoot: string,
  mergeBaseOid: string,
  headOid: string,
): Promise<{ commits: TerminalPreviewBranchCommitItem[]; truncated: boolean }> {
  if (mergeBaseOid === headOid) return { commits: [], truncated: false };
  const output = await runGit(
    repoRoot,
    [
      "log",
      "--date-order",
      `--max-count=${BRANCH_COMMITS_LIMIT + 1}`,
      "-z",
      "--format=%H%x00%h%x00%s%x00%an%x00%cI",
      "--end-of-options",
      `${mergeBaseOid}..${headOid}`,
      "--",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  if (!output) return { commits: [], truncated: false };
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5 !== 0) {
    throw new TerminalPreviewError("Invalid Git commit log output", 500);
  }
  const allCommits: TerminalPreviewBranchCommitItem[] = [];
  for (let i = 0; i < fields.length; i += 5) {
    const [oid = "", shortOid = "", subject = "", authorName = "", committedAt = ""] = fields.slice(i, i + 5);
    if (!/^[a-f0-9]{40,64}$/.test(oid)) {
      throw new TerminalPreviewError("Invalid Git commit OID", 500);
    }
    allCommits.push({ oid, shortOid: shortOid || oid.slice(0, 7), subject, authorName, committedAt });
  }
  const truncated = allCommits.length > BRANCH_COMMITS_LIMIT;
  return {
    commits: truncated ? allCommits.slice(0, BRANCH_COMMITS_LIMIT) : allCommits,
    truncated,
  };
}

export async function getPreviewGitBranchCommits(params: {
  projectId: string;
  projectPath: string | null | undefined;
  mainBranch?: string | null;
  commitOid?: string;
}): Promise<TerminalPreviewBranchCommitsResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  if (params.commitOid !== undefined && !/^[a-f0-9]{40,64}$/.test(params.commitOid)) {
    throw new TerminalPreviewError("Invalid commit OID", 400);
  }
  const comparison = await resolveReadonlyLocalBaseComparison(projectPath, params.mainBranch ?? null);
  if (comparison.state !== "ready") {
    return {
      kind: "git-branch-commits",
      projectId: params.projectId,
      projectPath,
      repoRoot: comparison.repoRoot,
      state: "unavailable",
      reason: comparison.reason,
      truncated: false,
      commits: [],
      selectedCommitOid: null,
      files: [],
    };
  }
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);
  const { commits, truncated } = await listBranchCommitItems(
    repoRoot,
    comparison.mergeBaseOid,
    comparison.headOid,
  );
  if (params.commitOid && !commits.some((item) => item.oid === params.commitOid)) {
    throw new TerminalPreviewError(
      "Commit is no longer in the current branch window; refresh the list",
      409,
      "terminal_preview_stale_diff",
    );
  }
  const selectedCommitOid = params.commitOid ?? commits[0]?.oid ?? null;
  const pathspec = projectRelativeToRepo || ".";
  const filesOutput = selectedCommitOid
    ? await runGit(
        repoRoot,
        [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "-m",
          "--first-parent",
          "-r",
          "--name-status",
          "-z",
          "-M",
          "--end-of-options",
          selectedCommitOid,
          "--",
          pathspec,
        ],
        { maxBuffer: 2 * 1024 * 1024 },
      )
    : "";
  const files = selectedCommitOid
    ? Array.from(parseNameStatusZ(filesOutput, projectRelativeToRepo).values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      )
    : [];
  return {
    kind: "git-branch-commits",
    projectId: params.projectId,
    projectPath,
    repoRoot,
    state: "ready",
    baseRef: comparison.baseRef,
    mergeBaseOid: comparison.mergeBaseOid,
    headOid: comparison.headOid,
    truncated,
    commits,
    selectedCommitOid,
    files,
  };
}

export async function resetPreviewGitChange(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  changeKind: TerminalPreviewWritableChangeKind;
}): Promise<TerminalPreviewResetChangeResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewGitPath(projectPath, params.requestedPath);
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);
  const repoPath = toRepoPath(projectRelativeToRepo, relativePath);
  const statusOutput = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", repoPath],
    { maxBuffer: 1024 * 1024 },
  );
  const changes = parseGitStatus(statusOutput, projectRelativeToRepo);
  const change = changes[params.changeKind].find((entry) => entry.path === relativePath);
  if (!change) throw new TerminalPreviewError("No selected change to reset", 409);

  if (params.changeKind === "staged") {
    await runGit(repoRoot, ["restore", "--staged", "--", repoPath]);
  } else if (change.status === "untracked") {
    const fileStats = await lstat(absolutePath).catch(() => null);
    if (!fileStats) throw new TerminalPreviewError("File not found", 404);
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
  mainBranch?: string | null;
  baseOid?: string;
  commitOid?: string;
};

async function resolveFirstParentOid(repoRoot: string, commitOid: string): Promise<string | null> {
  const line = (
    await runGit(repoRoot, ["rev-list", "--parents", "-n", "1", "--end-of-options", commitOid])
  ).trim();
  const parts = line.split(" ").filter(Boolean);
  if (parts[0] !== commitOid) {
    throw new TerminalPreviewError("Commit no longer exists; refresh the list", 409, "terminal_preview_stale_diff");
  }
  return parts[1] ?? null;
}

async function readComparison(params: ChangeRequest) {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewGitPath(projectPath, params.requestedPath);
  const { repoRoot, projectRelativeToRepo } = await resolveGitContext(projectPath);

  let change: TerminalPreviewChangeFile | undefined;
  let oldSource: TerminalPreviewContentSide["source"];
  let newSource: TerminalPreviewContentSide["source"];
  let oldTreeOid: string | null | undefined;
  let newTreeOid: string | null | undefined;

  if (params.changeKind === "branch") {
    if (!params.baseOid || !/^[a-f0-9]{40,64}$/.test(params.baseOid)) {
      throw new TerminalPreviewError("Invalid baseOid for branch diff", 400);
    }
    const branchChanges = await getPreviewGitBranchChanges({
      projectId: params.projectId,
      projectPath,
      mainBranch: params.mainBranch ?? null,
    });
    if (branchChanges.state !== "ready" || branchChanges.mergeBaseOid !== params.baseOid) {
      throw new TerminalPreviewError("Branch merge-base changed; refresh the list", 409, "terminal_preview_stale_diff");
    }
    change = branchChanges.files.find((entry) => entry.path === relativePath);
    oldSource = "merge-base";
    newSource = "working";
    oldTreeOid = branchChanges.mergeBaseOid;
  } else if (params.changeKind === "commit") {
    if (!params.commitOid || !/^[a-f0-9]{40,64}$/.test(params.commitOid)) {
      throw new TerminalPreviewError("Invalid commitOid for commit diff", 400);
    }
    const branchCommits = await getPreviewGitBranchCommits({
      projectId: params.projectId,
      projectPath,
      mainBranch: params.mainBranch ?? null,
      commitOid: params.commitOid,
    });
    if (branchCommits.state !== "ready" || branchCommits.selectedCommitOid !== params.commitOid) {
      throw new TerminalPreviewError("Commit is no longer in the current branch window; refresh the list", 409, "terminal_preview_stale_diff");
    }
    change = branchCommits.files.find((entry) => entry.path === relativePath);
    oldSource = "commit-parent";
    newSource = "commit";
    oldTreeOid = await resolveFirstParentOid(repoRoot, params.commitOid);
    newTreeOid = params.commitOid;
  } else {
    // Preserve rename source paths: a destination-only pathspec loses Git's rename pairing.
    const changes = await getPreviewGitChanges(params);
    change = changes[params.changeKind].find((entry) => entry.path === relativePath);
    oldSource = params.changeKind === "staged" ? "head" : "index";
    newSource = params.changeKind === "staged" ? "index" : "working";
  }

  if (!change) throw new TerminalPreviewError("Change no longer exists; refresh the list", 409, "terminal_preview_stale_diff");
  if (["renamed", "copied"].includes(change.status) && !change.oldPath) {
    throw new TerminalPreviewError("Original path is outside the project", 403);
  }
  const oldPath = change.oldPath ?? relativePath;
  const read = (filePath: string, source: TerminalPreviewContentSide["source"], treeOid?: string | null) =>
    readChangeContent({
      projectPath,
      repoRoot,
      repoPath: toRepoPath(projectRelativeToRepo, filePath),
      filePath,
      source,
      treeOid,
    });
  const [old, next] = await Promise.all([
    read(oldPath, oldSource, oldTreeOid),
    read(relativePath, newSource, newTreeOid),
  ]);
  if (next.side.state === "missing" && change.status !== "deleted") {
    throw new TerminalPreviewError("Change moved; refresh the list", 409, "terminal_preview_stale_diff");
  }
  if (old.side.state === "missing" && !["added", "untracked"].includes(change.status)) {
    throw new TerminalPreviewError("Original version moved; refresh the list", 409, "terminal_preview_stale_diff");
  }
  const preferred = change.status === "deleted" ? old : next;
  const textComparable = [old, next].every(({ side }) => side.state === "missing"
    || (side.state === "ready" && side.contentKind === "text"));
  const payload: TerminalPreviewFileDiffResponse = {
    kind: "file-diff", projectId: params.projectId, projectPath, repoRoot,
    changeKind: params.changeKind,
    ...(params.changeKind === "branch" && params.baseOid ? { baseOid: params.baseOid } : {}),
    ...(params.changeKind === "commit" && params.commitOid ? { commitOid: params.commitOid } : {}),
    path: relativePath, absolutePath, status: change.status,
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
