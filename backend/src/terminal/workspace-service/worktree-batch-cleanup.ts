import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  BatchCleanupWorktreeItemResult,
  BatchCleanupWorktreesRequest,
  BatchCleanupWorktreesResponse,
} from "@runweave/shared/terminal/project-context";
import { logger } from "../../logging/index";
import type { TerminalSessionManager } from "../manager/manager";
import {
  TerminalWorktreeDeletionError,
  type TerminalWorktreeDeletionService,
} from "./worktree-deletion";
import { parsePorcelainWorktrees } from "./worktree-governance";
import { WorktreeProvisioner } from "./worktree-provisioner";

const exec = promisify(execFile);
const cleanupLogger = logger.child({ component: "terminal-worktree-batch" });

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

export async function runWorktreeBatchCleanup(
  manager: TerminalSessionManager,
  deletionService: TerminalWorktreeDeletionService,
  parentProjectId: string,
  request: BatchCleanupWorktreesRequest,
): Promise<BatchCleanupWorktreesResponse> {
  const forceConfirmed = new Set(request.forceConfirmedProjectIds ?? []);
  const uniqueIds = Array.from(new Set(request.childProjectIds));
  const results: BatchCleanupWorktreeItemResult[] = [];
  for (const childProjectId of uniqueIds) {
    try {
      const deleted = await deletionService.delete(
        parentProjectId,
        childProjectId,
        {
          force: forceConfirmed.has(childProjectId),
          rejectIfPinned: true,
          rejectIfUnmerged: !forceConfirmed.has(childProjectId),
          deleteMergedBranch: request.deleteMergedLocalBranches === true,
        },
      );
      results.push({
        childProjectId,
        status: "deleted",
        branchDeleted: deleted.branchDeleted,
        cleanupWarnings: deleted.cleanupWarnings,
      });
    } catch (error) {
      results.push({
        childProjectId,
        status: "failed",
        errorCode:
          error instanceof TerminalWorktreeDeletionError
            ? error.code
            : "delete_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let prunedCount = 0;
  if (request.pruneMetadata) {
    const parent = manager
      .listProjects()
      .find((project) => project.id === parentProjectId);
    const parentPath = parent?.path
      ? await realpath(parent.path).catch(() => null)
      : null;
    if (parentPath) {
      const release = await WorktreeProvisioner.acquireParent(parentPath);
      try {
        const before = parsePorcelainWorktrees(
          await runGit(parentPath, ["worktree", "list", "--porcelain", "-z"]),
        ).filter((entry) => entry.prunable !== null).length;
        if (before > 0) {
          await runGit(parentPath, ["worktree", "prune"]);
          const after = parsePorcelainWorktrees(
            await runGit(parentPath, ["worktree", "list", "--porcelain", "-z"]),
          ).filter((entry) => entry.prunable !== null).length;
          prunedCount = Math.max(0, before - after);
        }
        await manager.refreshProjectContexts(parentProjectId);
      } catch (error) {
        cleanupLogger.warn("terminal.worktree.prune.failed", {
          parentProjectId,
          error,
        });
      } finally {
        release();
      }
    }
  }
  return { results, prunedCount };
}
