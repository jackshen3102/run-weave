import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTeamSourceFingerprint } from "@runweave/shared/agent-team";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const EXCLUDED_PATHS = [".runweave/**", "docs/review/**"];

export async function captureRepairSourceFingerprint(
  projectRoot: string,
): Promise<AgentTeamSourceFingerprint> {
  const repoRoot = (
    await runGit(projectRoot, ["rev-parse", "--show-toplevel"])
  ).trim();
  const head = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  const exclusions = EXCLUDED_PATHS.map((value) => `:(exclude)${value}`);
  const trackedDiff = await runGit(repoRoot, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
    ".",
    ...exclusions,
  ]);
  const untracked = (
    await runGit(repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ...exclusions,
    ])
  )
    .split("\0")
    .filter(Boolean)
    .sort();

  const hash = createHash("sha256");
  hash.update(`HEAD\0${head}\0DIFF\0${trackedDiff}\0UNTRACKED\0`);
  for (const relativePath of untracked) {
    const absolutePath = path.join(repoRoot, relativePath);
    const fileStat = await lstat(absolutePath);
    hash.update(`${relativePath}\0${fileStat.mode}\0`);
    hash.update(
      fileStat.isSymbolicLink()
        ? await readlink(absolutePath)
        : await readFile(absolutePath),
    );
    hash.update("\0");
  }
  return { repoRoot, sha256: hash.digest("hex") };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (
    await execFileAsync("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
    })
  ).stdout;
}
