import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentTeamReviewCheckpoint,
  AgentTeamReviewCheckpointState,
  AgentTeamReviewScope,
  AgentTeamReviewTarget,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 10 * 1024 * 1024;
const CHECKPOINT_EXCLUDED_PATH_PREFIXES = [".runweave/", "docs/review/"];

function isCheckpointExcludedPath(filePath: string): boolean {
  return CHECKPOINT_EXCLUDED_PATH_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

interface GitStatusEntry {
  status: string;
  path: string;
}

export interface ReviewCheckpointPreflight {
  repoRoot: string;
  originalBranch: string;
  taskBaseCommit: string;
}

export class AgentTeamReviewCheckpointGit {
  async preflight(projectRoot: string): Promise<ReviewCheckpointPreflight> {
    const repoRoot = (
      await this.runGit(projectRoot, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    const originalBranch = (
      await this.runGit(repoRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    const taskBaseCommit = (
      await this.runGit(repoRoot, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim();
    const statusOutput = (
      await this.runGit(repoRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout;
    const pendingCodePaths = this.statusPaths(statusOutput).filter(
      (filePath) => !isCheckpointExcludedPath(filePath),
    );
    if (pendingCodePaths.length > 0) {
      throw new AgentTeamError(
        409,
        "Review checkpoint 要求干净 Git worktree；请先提交/清理当前改动，或关闭 checkpoint 模式",
      );
    }
    return { repoRoot, originalBranch, taskBaseCommit };
  }

  async createRunBranch(repoRoot: string, branch: string): Promise<void> {
    await this.runGit(repoRoot, ["switch", "-c", branch]);
  }

  async prepareReviewTarget(params: {
    state: AgentTeamReviewCheckpointState;
    scope: AgentTeamReviewScope;
    planSha256: string | null;
    testCaseSha256: string | null;
    expectedHeadCommit?: string;
    rebasedCheckpointCommit?: string;
  }): Promise<AgentTeamReviewTarget> {
    const { state, scope } = params;
    if (scope === "final") {
      if (params.expectedHeadCommit) {
        await this.assertCheckpointHead(
          state,
          [],
          params.expectedHeadCommit,
          params.rebasedCheckpointCommit,
        );
      } else {
        await this.assertBranchAndHead(state);
      }
      const targetCommit =
        params.expectedHeadCommit ?? state.lastReviewedCommit;
      const targetTree = (
        await this.runGit(state.repoRoot, [
          "rev-parse",
          `${targetCommit}^{tree}`,
        ])
      ).stdout.trim();
      const changedPaths = await this.diffNames(
        state.repoRoot,
        state.taskBaseCommit,
        targetCommit,
        false,
      );
      return {
        scope,
        baseCommit: state.taskBaseCommit,
        targetCommit,
        targetTree,
        changedPaths,
        planSha256: params.planSha256,
        testCaseSha256: params.testCaseSha256,
        requestedAt: new Date().toISOString(),
      };
    }

    await this.assertBranchAndHead(state);
    const pendingEntries = await this.assertSafePendingPaths(state.repoRoot);
    await this.runGit(state.repoRoot, [
      "add",
      "-u",
      "--",
      ".",
      ...CHECKPOINT_EXCLUDED_PATH_PREFIXES.map(
        (prefix) => `:(exclude)${prefix}**`,
      ),
    ]);
    const untrackedPaths = pendingEntries
      .filter(
        (entry) =>
          entry.status === "??" && !isCheckpointExcludedPath(entry.path),
      )
      .map((entry) => `:(literal)${entry.path}`);
    if (untrackedPaths.length > 0) {
      await this.runGit(state.repoRoot, ["add", "--", ...untrackedPaths]);
    }
    const baseCommit =
      scope === "full" ? state.taskBaseCommit : state.lastReviewedCommit;
    const targetTree = (
      await this.runGit(state.repoRoot, ["write-tree"])
    ).stdout.trim();
    const changedPaths = await this.diffNames(
      state.repoRoot,
      baseCommit,
      null,
      true,
    );
    if (changedPaths.length === 0) {
      throw new AgentTeamError(
        409,
        "Code worker 没有产生可审查的代码 diff，未创建空 checkpoint",
      );
    }
    return {
      scope,
      baseCommit,
      targetTree,
      changedPaths,
      planSha256: params.planSha256,
      testCaseSha256: params.testCaseSha256,
      requestedAt: new Date().toISOString(),
    };
  }

  async assertReviewTargetUnchanged(
    state: AgentTeamReviewCheckpointState,
    target: AgentTeamReviewTarget,
  ): Promise<void> {
    const finalTargetCommit =
      target.scope === "final" ? target.targetCommit : null;
    if (finalTargetCommit) {
      await this.assertBranchAndCommit(state, finalTargetCommit);
    } else {
      await this.assertBranchAndHead(state);
    }
    const actualTree =
      target.scope === "final"
        ? (
            await this.runGit(state.repoRoot, [
              "rev-parse",
              `${finalTargetCommit ?? state.lastReviewedCommit}^{tree}`,
            ])
          ).stdout.trim()
        : (await this.runGit(state.repoRoot, ["write-tree"])).stdout.trim();
    if (actualTree !== target.targetTree) {
      throw new AgentTeamError(
        409,
        `Review target 已漂移：expected tree ${target.targetTree}，actual ${actualTree}`,
      );
    }
    const unstagedPaths = await this.workingDiffNames(state.repoRoot);
    if (unstagedPaths.length > 0) {
      throw new AgentTeamError(
        409,
        `Reviewer 执行期间代码 worktree 已变化：${unstagedPaths.join(", ")}`,
      );
    }
  }

  async commitReviewedTarget(params: {
    runId: string;
    reviewRound: number;
    reviewerPanelId: string | null;
    state: AgentTeamReviewCheckpointState;
    target: AgentTeamReviewTarget;
  }): Promise<AgentTeamReviewCheckpoint> {
    const { state, target } = params;
    await this.assertReviewTargetUnchanged(state, target);
    const sequence = state.checkpoints.length + 1;
    const subject = `checkpoint(agent-team): ${params.runId} review ${sequence}`;
    const body = [
      `Runweave-Agent-Team-Run: ${params.runId}`,
      `Runweave-Review-Sequence: ${sequence}`,
      `Runweave-Review-Tree: ${target.targetTree}`,
    ].join("\n");
    await this.runGit(state.repoRoot, [
      "-c",
      "user.name=Runweave Agent Team",
      "-c",
      "user.email=agent-team@runweave.local",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      subject,
      "-m",
      body,
    ]);
    const commit = (
      await this.runGit(state.repoRoot, ["rev-parse", "HEAD"])
    ).stdout.trim();
    const tree = (
      await this.runGit(state.repoRoot, ["rev-parse", "HEAD^{tree}"])
    ).stdout.trim();
    if (tree !== target.targetTree) {
      throw new AgentTeamError(
        409,
        `Checkpoint tree 与 reviewed tree 不一致：expected ${target.targetTree}，actual ${tree}`,
      );
    }
    return {
      sequence,
      commit,
      parentCommit: state.lastReviewedCommit,
      tree,
      reviewRound: params.reviewRound,
      reviewerPanelId: params.reviewerPanelId,
      createdAt: new Date().toISOString(),
    };
  }

  async recoverCommittedCheckpoint(params: {
    runId: string;
    reviewRound: number;
    reviewerPanelId: string | null;
    state: AgentTeamReviewCheckpointState;
    target: AgentTeamReviewTarget;
  }): Promise<AgentTeamReviewCheckpoint | null> {
    const { state, target } = params;
    const branch = (
      await this.runGit(state.repoRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    const head = (
      await this.runGit(state.repoRoot, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (branch !== state.branch) {
      return null;
    }
    if (head === state.lastReviewedCommit) {
      return null;
    }
    const [parent, tree, message] = await Promise.all([
      this.runGit(state.repoRoot, ["rev-parse", "HEAD^"]).then((item) =>
        item.stdout.trim(),
      ),
      this.runGit(state.repoRoot, ["rev-parse", "HEAD^{tree}"]).then((item) =>
        item.stdout.trim(),
      ),
      this.runGit(state.repoRoot, ["show", "-s", "--format=%B", "HEAD"]).then(
        (item) => item.stdout,
      ),
    ]);
    const sequence = state.checkpoints.length + 1;
    if (
      parent !== state.lastReviewedCommit ||
      tree !== target.targetTree ||
      !message.includes(`Runweave-Agent-Team-Run: ${params.runId}`) ||
      !message.includes(`Runweave-Review-Sequence: ${sequence}`) ||
      !message.includes(`Runweave-Review-Tree: ${target.targetTree}`)
    ) {
      return null;
    }
    return {
      sequence,
      commit: head,
      parentCommit: parent,
      tree,
      reviewRound: params.reviewRound,
      reviewerPanelId: params.reviewerPanelId,
      createdAt: new Date().toISOString(),
    };
  }

  async assertCheckpointHead(
    state: AgentTeamReviewCheckpointState,
    allowedDirtyPaths: string[] = [],
    expectedHeadCommit?: string,
    rebasedCheckpointCommit?: string,
  ): Promise<void> {
    if (expectedHeadCommit) {
      const branch = (
        await this.runGit(state.repoRoot, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])
      ).stdout.trim();
      const head = (
        await this.runGit(state.repoRoot, ["rev-parse", "HEAD"])
      ).stdout.trim();
      const checkpointAnchor = rebasedCheckpointCommit
        ? await this.verifyRebasedCheckpointAnchor(
            state,
            rebasedCheckpointCommit,
          )
        : state.lastReviewedCommit;
      const mergeBase = (
        await this.runGit(state.repoRoot, [
          "merge-base",
          checkpointAnchor,
          expectedHeadCommit,
        ])
      ).stdout.trim();
      if (
        branch !== state.branch ||
        head !== expectedHeadCommit ||
        mergeBase !== checkpointAnchor
      ) {
        throw new AgentTeamError(
          409,
          `Agent intervention checkpoint HEAD 无效：expected ${state.branch}@${expectedHeadCommit} descendant of ${checkpointAnchor}，actual ${branch}@${head}`,
        );
      }
    } else {
      await this.assertBranchAndHead(state);
    }
    const statusOutput = (
      await this.runGit(state.repoRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).stdout;
    const pendingCodePaths = this.statusPaths(statusOutput).filter(
      (filePath) => !isCheckpointExcludedPath(filePath),
    );
    const pendingCodePathSet = new Set(pendingCodePaths);
    const staleAllowedPaths = allowedDirtyPaths.filter(
      (filePath) => !pendingCodePathSet.has(filePath),
    );
    if (staleAllowedPaths.length > 0) {
      throw new AgentTeamError(
        409,
        `Checkpoint dirty path 例外与当前 worktree 不一致：${staleAllowedPaths.join(", ")}`,
      );
    }
    const allowedDirtyPathSet = new Set(allowedDirtyPaths);
    const unacknowledgedCodePaths = pendingCodePaths.filter(
      (filePath) => !allowedDirtyPathSet.has(filePath),
    );
    if (unacknowledgedCodePaths.length > 0) {
      throw new AgentTeamError(
        409,
        `Checkpoint 后存在未提交代码，behavior 不得启动：${unacknowledgedCodePaths.join(", ")}`,
      );
    }
  }

  private async verifyRebasedCheckpointAnchor(
    state: AgentTeamReviewCheckpointState,
    commit: string,
  ): Promise<string> {
    const checkpoint = state.checkpoints.at(-1);
    if (!checkpoint || checkpoint.commit !== state.lastReviewedCommit) {
      throw new AgentTeamError(
        409,
        "Agent intervention 无法重锚：缺少 lastReviewedCommit 对应 checkpoint 记录",
      );
    }
    const message = (
      await this.runGit(state.repoRoot, ["show", "-s", "--format=%B", commit])
    ).stdout;
    if (
      !message.includes(`Runweave-Review-Sequence: ${checkpoint.sequence}`) ||
      !message.includes(`Runweave-Review-Tree: ${checkpoint.tree}`)
    ) {
      throw new AgentTeamError(
        409,
        `Agent intervention rebase 锚点与 checkpoint C${checkpoint.sequence}/${checkpoint.tree} 不匹配：${commit}`,
      );
    }
    return commit;
  }

  private async assertBranchAndHead(
    state: AgentTeamReviewCheckpointState,
  ): Promise<void> {
    await this.assertBranchAndCommit(state, state.lastReviewedCommit);
  }

  private async assertBranchAndCommit(
    state: AgentTeamReviewCheckpointState,
    expectedCommit: string,
  ): Promise<void> {
    const branch = (
      await this.runGit(state.repoRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    const head = (
      await this.runGit(state.repoRoot, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (branch !== state.branch || head !== expectedCommit) {
      throw new AgentTeamError(
        409,
        `Review checkpoint Git 状态已漂移：expected ${state.branch}@${expectedCommit}，actual ${branch}@${head}`,
      );
    }
  }

  private async assertSafePendingPaths(
    repoRoot: string,
  ): Promise<GitStatusEntry[]> {
    const output = (
      await this.runGit(repoRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).stdout;
    const entries = this.statusEntries(output);
    for (const entry of entries) {
      const rawPath = entry.path;
      if (!rawPath || isCheckpointExcludedPath(rawPath)) {
        continue;
      }
      const baseName = path.posix.basename(rawPath).toLowerCase();
      if (
        baseName === ".env" ||
        baseName.startsWith(".env.") ||
        baseName === ".npmrc" ||
        baseName.endsWith(".pem") ||
        baseName.endsWith(".key") ||
        /credential|secret|token/.test(baseName)
      ) {
        throw new AgentTeamError(
          409,
          `Review checkpoint 拒绝暂存敏感路径：${rawPath}`,
        );
      }
      if (entry.status === "??") {
        const fileStat = await stat(path.join(repoRoot, rawPath)).catch(
          () => null,
        );
        if (fileStat?.isFile() && fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
          throw new AgentTeamError(
            409,
            `Review checkpoint 拒绝暂存超过 10 MiB 的 untracked 文件：${rawPath}`,
          );
        }
      }
    }
    return entries;
  }

  private async workingDiffNames(repoRoot: string): Promise<string[]> {
    const output = (await this.runGit(repoRoot, ["diff", "--name-only", "-z"]))
      .stdout;
    return output
      .split("\0")
      .filter((filePath) => filePath && !isCheckpointExcludedPath(filePath));
  }

  private statusPaths(output: string): string[] {
    return this.statusEntries(output).map((entry) => entry.path);
  }

  private statusEntries(output: string): GitStatusEntry[] {
    const records = output.split("\0");
    const entries: GitStatusEntry[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) {
        continue;
      }
      const status = record.slice(0, 2);
      const filePath = record.slice(3);
      if (filePath) {
        entries.push({ status, path: filePath });
      }
      if (status.includes("R") || status.includes("C")) {
        index += 1;
      }
    }
    return entries;
  }

  private async diffNames(
    repoRoot: string,
    baseCommit: string,
    targetCommit: string | null,
    cached: boolean,
  ): Promise<string[]> {
    const args = ["diff"];
    if (cached) {
      args.push("--cached");
    }
    args.push("--name-only", "-z", baseCommit);
    if (targetCommit) {
      args.push(targetCommit);
    }
    const output = (await this.runGit(repoRoot, args)).stdout;
    return output
      .split("\0")
      .filter((filePath) => filePath && !isCheckpointExcludedPath(filePath));
  }

  private async runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const detail =
        error && typeof error === "object" && "stderr" in error
          ? String(error.stderr).trim()
          : error instanceof Error
            ? error.message
            : "Git command failed";
      throw new AgentTeamError(
        409,
        `Review checkpoint Git 操作失败：${detail}`,
      );
    }
  }
}
