import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RepositoryIdentity {
  repositoryId: string;
  commonDirectory: string;
  worktreeRoot: string;
}

/** Identity is local Git storage, not a Project registration or remote URL. */
export async function resolveRepositoryIdentity(
  cwd: string,
): Promise<RepositoryIdentity> {
  if (!path.isAbsolute(cwd)) throw new Error("repository_cwd_must_be_absolute");
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  try {
    const options = { cwd, env, timeout: 5000, maxBuffer: 64 * 1024 };
    const [root, common] = await Promise.all([
      exec("git", ["rev-parse", "--show-toplevel"], options),
      exec(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        options,
      ),
    ]);
    const commonDirectory = await realpath(common.stdout.trim());
    return {
      repositoryId: createHash("sha256").update(commonDirectory).digest("hex"),
      commonDirectory,
      worktreeRoot: await realpath(root.stdout.trim()),
    };
  } catch {
    throw new Error("repository_git_required");
  }
}

export async function readRepositoryRevision(
  cwd: string,
): Promise<string | null> {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  try {
    return (
      await exec("git", ["rev-parse", "--verify", "HEAD"], {
        cwd,
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      })
    ).stdout.trim();
  } catch {
    return null;
  }
}
