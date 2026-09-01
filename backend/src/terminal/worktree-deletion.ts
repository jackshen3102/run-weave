import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTerminalChildProjectId } from "@runweave/shared/terminal/project-context";
import { logger } from "../logging";
import {
  recordTerminalSessionDeleted,
  type TerminalActivityDependencies,
} from "./activity-events";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "./manager/manager";
import { clearPreviewFileSearchCache } from "./preview/preview";
import { killTmuxSessionForTerminal } from "./runtime/launcher";
import type { TerminalRuntimeRegistry } from "./runtime/registry";
import type { TerminalEventService } from "./state/terminal-event-service";
import type { TerminalStateService } from "./state/terminal-state-service";
import type { TmuxOutputWatcher } from "./tmux/output-watcher";
import type { TmuxService } from "./tmux/service";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const terminalWorktreeLogger = logger.child({ component: "terminal-worktree" });

interface GitWorktreeRecord {
  worktreePath: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
}

interface ResolvedWorktreeTarget {
  parentProjectId: string;
  childProjectId: string;
  parentPath: string;
  worktreePath: string;
  head: string;
  branch: string | null;
}

interface WorktreeDeletionHookInput {
  parentProjectId: string;
  childProjectId: string;
  worktreePath: string;
}

export interface TerminalWorktreeDeletionOwnerHooks {
  beforeDelete?: (input: WorktreeDeletionHookInput) => Promise<void>;
  afterDelete?: (
    input: WorktreeDeletionHookInput & { terminalSessionIds: string[] },
  ) => Promise<void>;
}

interface TerminalWorktreeDeletionOptions {
  terminalSessionManager: TerminalSessionManager;
  runtimeRegistry?: TerminalRuntimeRegistry;
  terminalStateService?: TerminalStateService;
  terminalEventService?: TerminalEventService;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  activity?: TerminalActivityDependencies;
  ownerHooks?: TerminalWorktreeDeletionOwnerHooks;
  env?: NodeJS.ProcessEnv;
}

export class TerminalWorktreeDeletionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
    readonly code?: string,
  ) {
    super(message);
    this.name = "TerminalWorktreeDeletionError";
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                error.message ||
                "Git command failed",
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseGitWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | null = null;
  const commitCurrent = (): void => {
    if (current?.worktreePath) {
      records.push(current);
    }
    current = null;
  };

  for (const rawField of output.split("\0")) {
    const field = rawField.replace(/^\n+|\n+$/gu, "");
    if (!field) {
      commitCurrent();
      continue;
    }
    if (field.startsWith("worktree ")) {
      commitCurrent();
      current = {
        worktreePath: field.slice("worktree ".length),
        head: null,
        branch: null,
        locked: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length) || null;
      continue;
    }
    if (field.startsWith("branch ")) {
      const branch = field.slice("branch ".length);
      current.branch = branch.startsWith("refs/heads/")
        ? branch.slice("refs/heads/".length)
        : branch || null;
      continue;
    }
    if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
    }
  }
  commitCurrent();
  return records;
}

function isDirectChild(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== "." &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath) &&
    path.dirname(relativePath) === "."
  );
}

async function findRegisteredWorktree(
  parentPath: string,
  worktreePath: string,
): Promise<GitWorktreeRecord | null> {
  const records = parseGitWorktreeList(
    await runGit(parentPath, ["worktree", "list", "--porcelain", "-z"]),
  );
  for (const record of records) {
    const recordPath = await realpath(record.worktreePath).catch(() => null);
    if (recordPath === worktreePath) {
      return record;
    }
  }
  return null;
}

async function findBlockingDevSession(
  sourceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<{ devSessionId: string; state: string } | null> {
  const registryRoot = path.resolve(
    env.RUNWEAVE_DEV_SESSION_HOME?.trim() ||
      path.join(os.homedir(), ".runweave", "dev-sessions"),
  );
  const entries = await readdir(registryRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(registryRoot, entry.name, "manifest.json");
    try {
      const stats = await lstat(manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        continue;
      }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        devSessionId?: unknown;
        state?: unknown;
        source?: { root?: unknown };
      };
      if (
        typeof manifest.source?.root !== "string" ||
        typeof manifest.state !== "string" ||
        manifest.state === "stopped"
      ) {
        continue;
      }
      const manifestSourceRoot =
        (await realpath(manifest.source.root).catch(() => null)) ??
        path.resolve(manifest.source.root);
      if (manifestSourceRoot !== sourceRoot) {
        continue;
      }
      return {
        devSessionId:
          typeof manifest.devSessionId === "string"
            ? manifest.devSessionId
            : entry.name,
        state: manifest.state,
      };
    } catch {
      // Invalid or newer manifests do not establish ownership.
    }
  }
  return null;
}

export class TerminalWorktreeDeletionService {
  private readonly deletingProjectIds = new Set<string>();

  constructor(private readonly options: TerminalWorktreeDeletionOptions) {}

  async delete(parentProjectId: string, childProjectId: string): Promise<void> {
    if (this.deletingProjectIds.has(childProjectId)) {
      throw new TerminalWorktreeDeletionError(
        "Worktree deletion is already in progress",
        409,
        "deletion_in_progress",
      );
    }
    this.deletingProjectIds.add(childProjectId);
    try {
      const initialTarget = await this.resolveSafeTarget(
        parentProjectId,
        childProjectId,
      );
      await this.options.ownerHooks?.beforeDelete?.(initialTarget);

      const target = await this.resolveSafeTarget(
        parentProjectId,
        childProjectId,
      );
      const sessions = this.listTargetSessions(childProjectId);
      this.assertNoRunningAgent(sessions);
      await this.closeSessions(sessions);

      const finalTarget = await this.resolveSafeTarget(
        parentProjectId,
        childProjectId,
      );
      if (finalTarget.worktreePath !== target.worktreePath) {
        throw new TerminalWorktreeDeletionError(
          "Worktree identity changed during deletion; refresh and retry",
          409,
          "identity_changed",
        );
      }
      if (this.listTargetSessions(childProjectId).length > 0) {
        throw new TerminalWorktreeDeletionError(
          "A new Terminal appeared while deleting the Worktree; retry",
          409,
          "terminal_appeared",
        );
      }

      try {
        await runGit(finalTarget.parentPath, [
          "worktree",
          "remove",
          "--",
          finalTarget.worktreePath,
        ]);
      } catch (error) {
        throw new TerminalWorktreeDeletionError(
          `Git refused to delete the Worktree: ${error instanceof Error ? error.message : String(error)}`,
          409,
          "git_remove_failed",
        );
      }

      await this.options.terminalSessionManager.removeProjectContextMetadata(
        parentProjectId,
        childProjectId,
      );
      clearPreviewFileSearchCache(childProjectId);
      await this.options.terminalSessionManager.refreshProjectContexts(
        parentProjectId,
      );

      try {
        await this.options.ownerHooks?.afterDelete?.({
          ...finalTarget,
          terminalSessionIds: sessions.map((session) => session.id),
        });
      } catch (error) {
        terminalWorktreeLogger.warn("terminal.worktree.owner-sync.failed", {
          message:
            "Worktree was deleted but owner state synchronization failed",
          parentProjectId,
          childProjectId,
          error,
        });
      }
    } finally {
      this.deletingProjectIds.delete(childProjectId);
    }
  }

  private listTargetSessions(childProjectId: string): TerminalSessionRecord[] {
    return this.options.terminalSessionManager
      .listSessions()
      .filter((session) => session.projectId === childProjectId);
  }

  private assertNoRunningAgent(sessions: TerminalSessionRecord[]): void {
    for (const session of sessions) {
      const terminalState =
        this.options.terminalStateService?.getCurrent(session.id, session) ??
        session.terminalState;
      if (
        terminalState?.state === "agent_starting" ||
        terminalState?.state === "agent_running"
      ) {
        throw new TerminalWorktreeDeletionError(
          `Worktree is used by a running ${terminalState.agent ?? "Agent"} session`,
          409,
          "agent_running",
        );
      }
    }
  }

  private async closeSessions(
    sessions: TerminalSessionRecord[],
  ): Promise<void> {
    for (const session of sessions) {
      await this.options.runtimeRegistry?.disposeRuntime(session.id);
      await this.options.tmuxOutputWatcher?.unwatchSession(session.id);
      await killTmuxSessionForTerminal(session, this.options.tmuxService);
      await this.options.terminalSessionManager.destroySession(session.id);
      this.options.terminalEventService?.record({
        kind: "terminal_session_deleted",
        terminalSessionId: session.id,
        projectId: session.projectId,
        payload: {
          terminalSessionId: session.id,
          projectId: session.projectId,
        },
      });
      recordTerminalSessionDeleted(this.options.activity, session);
    }
  }

  private async resolveSafeTarget(
    parentProjectId: string,
    childProjectId: string,
  ): Promise<ResolvedWorktreeTarget> {
    const parsed = parseTerminalChildProjectId(childProjectId);
    if (!parsed || parsed.parentProjectId !== parentProjectId) {
      throw new TerminalWorktreeDeletionError(
        "Worktree does not belong to this Project",
        404,
        "context_not_found",
      );
    }
    const parent = this.options.terminalSessionManager
      .listProjects()
      .find((project) => project.id === parentProjectId);
    if (!parent?.path) {
      throw new TerminalWorktreeDeletionError(
        "Parent Project path is unavailable",
        409,
        "parent_unavailable",
      );
    }
    const contexts =
      await this.options.terminalSessionManager.refreshProjectContexts(
        parentProjectId,
      );
    const context = contexts?.find(
      (candidate) => candidate.projectId === childProjectId,
    );
    if (!context) {
      throw new TerminalWorktreeDeletionError(
        "Worktree is no longer available; refresh and retry",
        404,
        "context_not_found",
      );
    }
    if (context.isPrimary) {
      throw new TerminalWorktreeDeletionError(
        "The primary Project workspace cannot be deleted as a Worktree",
        400,
        "primary_context",
      );
    }
    if (context.availability !== "available" || !context.path) {
      throw new TerminalWorktreeDeletionError(
        "Worktree path is unavailable and cannot be safely deleted",
        409,
        "context_unavailable",
      );
    }

    const parentPath = await realpath(parent.path).catch(() => null);
    const worktreePath = await realpath(context.path).catch(() => null);
    if (!parentPath || !worktreePath) {
      throw new TerminalWorktreeDeletionError(
        "Worktree path is unavailable and cannot be safely deleted",
        409,
        "context_unavailable",
      );
    }
    const expectedRoot = path.join(parentPath, ".worktree");
    const worktreeRoot = await realpath(expectedRoot).catch(() => null);
    if (
      !worktreeRoot ||
      path.relative(parentPath, worktreeRoot) !== ".worktree"
    ) {
      throw new TerminalWorktreeDeletionError(
        "Worktree root is outside the managed Project path",
        403,
        "unsafe_root",
      );
    }
    const relativePath = path.relative(worktreeRoot, worktreePath);
    if (
      !isDirectChild(relativePath) ||
      relativePath.normalize("NFC") !== parsed.worktreeName
    ) {
      throw new TerminalWorktreeDeletionError(
        "Worktree path is outside the managed Project path",
        403,
        "unsafe_path",
      );
    }

    const registered = await findRegisteredWorktree(parentPath, worktreePath);
    if (!registered) {
      throw new TerminalWorktreeDeletionError(
        "Worktree is not registered under this Project",
        409,
        "not_registered",
      );
    }
    if (registered.locked) {
      throw new TerminalWorktreeDeletionError(
        "Worktree is locked by Git and cannot be deleted",
        409,
        "worktree_locked",
      );
    }
    if (!registered.head) {
      throw new TerminalWorktreeDeletionError(
        "Worktree HEAD cannot be resolved",
        409,
        "head_unavailable",
      );
    }
    if (
      (
        await runGit(worktreePath, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
      ).length > 0
    ) {
      throw new TerminalWorktreeDeletionError(
        "Worktree has uncommitted or untracked changes; handle them before deleting",
        409,
        "worktree_dirty",
      );
    }
    if (!registered.branch) {
      const containingRefs = await runGit(parentPath, [
        "for-each-ref",
        "--format=%(refname)",
        `--contains=${registered.head}`,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]);
      if (!containingRefs.trim()) {
        throw new TerminalWorktreeDeletionError(
          "Detached Worktree commit has no branch or tag reference",
          409,
          "detached_head_unreferenced",
        );
      }
    }

    const blockingDevSession = await findBlockingDevSession(
      worktreePath,
      this.options.env ?? process.env,
    );
    if (blockingDevSession) {
      throw new TerminalWorktreeDeletionError(
        `Worktree is used by Dev Session ${blockingDevSession.devSessionId} (${blockingDevSession.state})`,
        409,
        "dev_session_active",
      );
    }

    return {
      parentProjectId,
      childProjectId,
      parentPath,
      worktreePath,
      head: registered.head,
      branch: registered.branch,
    };
  }
}
