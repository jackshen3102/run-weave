import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { KeyedMutex } from "./manager-runtime";

const exec = promisify(execFile);
const parents = new KeyedMutex();

export class WorktreeProvisionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export async function worktreeGit(
  cwd: string,
  args: string[],
): Promise<string> {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  const { stdout } = await exec("git", args, {
    cwd,
    env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export class WorktreeProvisioner {
  static async acquireParent(projectPath: string) {
    return parents.acquire(await realpath(projectPath));
  }

  static async root(parentPath: string) {
    const root = path.join(await realpath(parentPath), ".worktree");
    await mkdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
      throw new WorktreeProvisionError(
        "Worktree root escapes the parent project",
        403,
      );
    return root;
  }

  static async resolveCommit(parent: string, ref: string) {
    const commit = (
      await worktreeGit(parent, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        ref + "^{commit}",
      ]).catch(() => "")
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit))
      throw new WorktreeProvisionError("Invalid base commit", 400);
    return commit;
  }

  /** The caller holds the canonical parent lock through context and terminal registration. */
  static async add(
    parent: string,
    name: string,
    branch: string,
    commit: string,
    existing = false,
  ) {
    if (
      !name ||
      path.basename(name) !== name ||
      /[/\\\0]/u.test(name) ||
      name === "." ||
      name === ".."
    )
      throw new WorktreeProvisionError("Invalid Worktree directory", 400);
    if (
      branch.startsWith("-") ||
      !branch ||
      (
        await worktreeGit(parent, [
          "check-ref-format",
          "--branch",
          branch,
        ]).catch(() => "")
      ).trimEnd() !== branch
    )
      throw new WorktreeProvisionError("Invalid Git branch", 400);
    const root = await this.root(parent);
    const target = path.join(root, name);
    const occupied = await lstat(target).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (occupied)
      throw new WorktreeProvisionError("Worktree directory already exists");
    if (existing) {
      await worktreeGit(parent, [
        "show-ref",
        "--verify",
        "refs/heads/" + branch,
      ]).catch(() => {
        throw new WorktreeProvisionError("Local branch does not exist");
      });
    }
    // The approved setup is the only checkout-time script initiated by this operation.
    const args = existing
      ? ["--", target, branch]
      : ["--no-track", "-b", branch, "--", target, commit];
    await worktreeGit(parent, [
      "-c",
      "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
      "worktree",
      "add",
      ...args,
    ]).catch((error) => {
      throw new WorktreeProvisionError(
        error.stderr?.trim() || "Git refused to create Worktree",
      );
    });
    if ((await realpath(target)) !== target)
      throw new WorktreeProvisionError("Worktree directory changed", 403);
    return target;
  }
}
