import { WorktreeProvisioner, WorktreeProvisionError, worktreeGit as runGit } from "../terminal/workspace-service/worktree-provisioner";
import { realpath } from "node:fs/promises";
import path from "node:path";



interface PlannedRaceWorktree {
  name: string;
  branch: string;
  worktreePath: string;
}

export interface RaceWorktreePlan {
  baseCommit: string;
  parentPath: string;
  worktreeRoot: string;
  worktrees: PlannedRaceWorktree[];
}

export interface CreatedRaceWorktree extends PlannedRaceWorktree {
  worktreePath: string;
}

export { WorktreeProvisionError as RaceWorktreeSupplyError };

function parseWorktreePaths(output: string): string[] {
  return output
    .split("\0")
    .map((field) => field.replace(/^\n+|\n+$/gu, ""))
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

function workerSuffix(index: number): string {
  let remaining = index;
  let suffix = "";
  do {
    suffix =
      String.fromCharCode(97 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return suffix;
}

export function buildRaceSlug(goal: string): string {
  const slug = goal
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24)
    .replace(/-+$/gu, "");
  return slug || "task";
}

function assertDirectRaceChild(
  worktreeRoot: string,
  candidatePath: string,
): void {
  const relativePath = path.relative(worktreeRoot, candidatePath);
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    path.dirname(relativePath) !== "." ||
    !path.basename(candidatePath).startsWith("race-")
  ) {
    throw new WorktreeProvisionError(
      "Race worktree path is outside the controlled .worktree/race-* namespace",
      403,
    );
  }
}

export class RaceWorktreeSupply {
  async plan(
    projectPath: string,
    goal: string,
    baseRef: string,
    count: number,
  ): Promise<RaceWorktreePlan> {
    const parentPath = await realpath(projectPath);
    const worktreeRootRealPath = await WorktreeProvisioner.root(parentPath);
    const baseCommit = await WorktreeProvisioner.resolveCommit(parentPath, baseRef);

    const [worktreeOutput, branchOutput] = await Promise.all([
      runGit(parentPath, ["worktree", "list", "--porcelain", "-z"]),
      runGit(parentPath, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/race/",
      ]),
    ]);
    const usedPaths = new Set(
      parseWorktreePaths(worktreeOutput).map((candidate) =>
        path.resolve(candidate),
      ),
    );
    const usedBranches = new Set(
      branchOutput
        .split(/\r?\n/u)
        .map((branch) => branch.trim())
        .filter(Boolean),
    );
    const slug = buildRaceSlug(goal);
    const worktrees: PlannedRaceWorktree[] = [];

    for (let index = 0; index < count; index += 1) {
      const suffix = workerSuffix(index);
      let collision = 1;
      while (true) {
        const collisionSuffix = collision === 1 ? "" : `-${collision}`;
        const name = `race-${slug}-${suffix}${collisionSuffix}`;
        const branch = `race/${slug}-${suffix}${collisionSuffix}`;
        const worktreePath = path.join(worktreeRootRealPath, name);
        assertDirectRaceChild(worktreeRootRealPath, worktreePath);
        if (
          !usedPaths.has(path.resolve(worktreePath)) &&
          !usedBranches.has(branch)
        ) {
          usedPaths.add(path.resolve(worktreePath));
          usedBranches.add(branch);
          worktrees.push({ name, branch, worktreePath });
          break;
        }
        collision += 1;
      }
    }

    return {
      baseCommit,
      parentPath,
      worktreeRoot: worktreeRootRealPath,
      worktrees,
    };
  }

  async create(
    plan: RaceWorktreePlan,
    worktree: PlannedRaceWorktree,
  ): Promise<CreatedRaceWorktree> {
    assertDirectRaceChild(plan.worktreeRoot, worktree.worktreePath);
    const createdPath = await WorktreeProvisioner.add(plan.parentPath, worktree.name, worktree.branch, plan.baseCommit);
    assertDirectRaceChild(plan.worktreeRoot, createdPath);
    return { ...worktree, worktreePath: createdPath };
  }

  async isRegistered(
    projectPath: string,
    worktreePath: string,
  ): Promise<boolean> {
    const parentPath = await realpath(projectPath).catch(() => null);
    if (!parentPath) {
      return false;
    }
    const worktreeRoot = await realpath(
      path.join(parentPath, ".worktree"),
    ).catch(() => null);
    const targetPath = await realpath(worktreePath).catch(() => null);
    if (worktreeRoot !== path.join(parentPath, ".worktree") || !targetPath) {
      return false;
    }
    try {
      assertDirectRaceChild(worktreeRoot, targetPath);
    } catch {
      return false;
    }
    const registeredPaths = await runGit(parentPath, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ])
      .then(parseWorktreePaths)
      .catch(() => []);
    const registeredRealPaths = await Promise.all(
      registeredPaths.map((candidate) =>
        realpath(candidate).catch(() => null),
      ),
    );
    return registeredRealPaths.includes(targetPath);
  }

  async remove(
    projectPath: string,
    worktreePath: string,
    beforeRemove: () => Promise<void>,
  ): Promise<void> {
    const parentPath = await realpath(projectPath);
    const worktreeRoot = await realpath(path.join(parentPath, ".worktree"));
    const targetPath = await realpath(worktreePath).catch(() => null);
    if (!targetPath) {
      throw new WorktreeProvisionError("Race worktree is missing", 404);
    }
    assertDirectRaceChild(worktreeRoot, targetPath);
    if (!(await this.isRegistered(parentPath, targetPath))) {
      throw new WorktreeProvisionError(
        "Race worktree is not registered under this parent project",
        409,
      );
    }
    if ((await runGit(targetPath, ["status", "--porcelain=v1"])).trim()) {
      throw new WorktreeProvisionError(
        "Race worktree has uncommitted changes",
        409,
      );
    }

    await beforeRemove();

    if (!(await this.isRegistered(parentPath, targetPath))) {
      throw new WorktreeProvisionError(
        "Race worktree changed before removal",
        409,
      );
    }
    if ((await runGit(targetPath, ["status", "--porcelain=v1"])).trim()) {
      throw new WorktreeProvisionError(
        "Race worktree became dirty before removal",
        409,
      );
    }
    await runGit(parentPath, ["worktree", "remove", "--", targetPath]);
  }
}
