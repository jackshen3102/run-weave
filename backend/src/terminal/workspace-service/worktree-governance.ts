import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_WORKTREE_GOVERNANCE_POLICY,
  type PrunableWorktreeRecord,
  type RecyclableWorktreeSlot,
  type ShareableWorktreeContext,
  type WorktreeGovernanceBucket,
  type WorktreeGovernanceItem,
  type WorktreeGovernancePolicy,
  type WorktreeGovernanceResponse,
} from "@runweave/shared/terminal/project-context";
import type {
  TerminalProjectContextRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import type { TerminalStateService } from "../state/terminal-state-service";
import {
  WorktreeProvisionError,
  worktreeGit,
} from "./worktree-provisioner";

const exec = promisify(execFile);
const MAX_DIRTY_PREVIEW_FILES = 30;
const DISK_USAGE_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface ParsedPorcelainWorktree {
  worktreePath: string;
  head: string | null;
  branch: string | null;
  prunable: string | null;
}

export function parsePorcelainWorktrees(
  output: string,
): ParsedPorcelainWorktree[] {
  const records: ParsedPorcelainWorktree[] = [];
  let current: ParsedPorcelainWorktree | null = null;
  const commit = (): void => {
    if (current?.worktreePath) records.push(current);
    current = null;
  };
  for (const rawField of output.split("\0")) {
    const field = rawField.replace(/^\n+|\n+$/gu, "");
    if (!field) {
      commit();
      continue;
    }
    if (field.startsWith("worktree ")) {
      commit();
      current = {
        worktreePath: field.slice("worktree ".length),
        head: null,
        branch: null,
        prunable: null,
      };
      continue;
    }
    if (!current) continue;
    if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length) || null;
    } else if (field.startsWith("branch ")) {
      const ref = field.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref || null;
    } else if (field === "prunable") {
      current.prunable = "gitdir missing";
    } else if (field.startsWith("prunable ")) {
      current.prunable = field.slice("prunable ".length) || "gitdir missing";
    }
  }
  commit();
  return records;
}

export async function resolveBaseRef(
  parentPath: string,
  mainBranch: string | null | undefined,
): Promise<{ baseRef: string | null; baseCommit: string | null }> {
  const shallow = (
    await worktreeGit(parentPath, [
      "rev-parse",
      "--is-shallow-repository",
    ]).catch(() => "")
  ).trim();
  const candidates: string[] = [];
  if (mainBranch?.trim()) {
    const trimmed = mainBranch.trim();
    if (trimmed.startsWith("origin/")) {
      candidates.push(trimmed);
    } else {
      candidates.push(`origin/${trimmed}`, trimmed);
    }
  }
  const remoteHead = (
    await worktreeGit(parentPath, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).catch(() => "")
  ).trim();
  if (remoteHead) candidates.push(remoteHead);
  candidates.push("origin/main", "origin/master", "main", "master");

  const seen = new Set<string>();
  for (const ref of candidates) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const commit = (
      await worktreeGit(parentPath, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]).catch(() => "")
    ).trim();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
      return {
        baseRef: ref,
        baseCommit: shallow === "true" ? null : commit,
      };
    }
  }
  return { baseRef: null, baseCommit: null };
}

async function inspectDirtyStatus(worktreePath: string): Promise<{
  isDirty: boolean;
  changedFilesCount: number;
  untrackedFilesCount: number;
  dirtyPreviewFiles: string[];
}> {
  const output = await worktreeGit(worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]).catch(() => null);
  if (output === null) {
    return {
      isDirty: true,
      changedFilesCount: 0,
      untrackedFilesCount: 0,
      dirtyPreviewFiles: [],
    };
  }
  const tokens = output.split("\0");
  let changedFilesCount = 0;
  let untrackedFilesCount = 0;
  const dirtyPreviewFiles: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (status === "??") untrackedFilesCount += 1;
    else changedFilesCount += 1;
    if (dirtyPreviewFiles.length < MAX_DIRTY_PREVIEW_FILES && filePath) {
      dirtyPreviewFiles.push(filePath);
    }
    if (status[0] === "R" || status[0] === "C") {
      i += 1;
    }
  }
  return {
    isDirty: changedFilesCount + untrackedFilesCount > 0,
    changedFilesCount,
    untrackedFilesCount,
    dirtyPreviewFiles,
  };
}

export async function checkMergedIntoBase(
  parentPath: string,
  head: string | null,
  baseCommit: string | null,
): Promise<boolean | null> {
  if (!head || !baseCommit) return null;
  if (head === baseCommit) return true;
  try {
    await worktreeGit(parentPath, [
      "merge-base",
      "--is-ancestor",
      head,
      baseCommit,
    ]);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 1) return false;
    return null;
  }
}

async function estimateWorktreeFilesystemActivityMs(
  worktreePath: string,
): Promise<number | null> {
  const [commitSecRaw, dirStat] = await Promise.all([
    worktreeGit(worktreePath, ["log", "-1", "--format=%ct", "HEAD"]).catch(
      () => "",
    ),
    stat(worktreePath).catch(() => null),
  ]);
  const commitSec = Number.parseInt(commitSecRaw.trim(), 10);
  const commitMs =
    Number.isFinite(commitSec) && commitSec > 0 ? commitSec * 1_000 : -1;
  const dirMs =
    dirStat && Number.isFinite(dirStat.mtimeMs) ? dirStat.mtimeMs : -1;
  const best = Math.max(commitMs, dirMs);
  return best > 0 ? best : null;
}

async function estimateDiskUsageBytes(
  directory: string,
): Promise<number | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await exec("du", ["-sk", directory], {
      timeout: DISK_USAGE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    const kb = Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "", 10);
    return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, Math.max(1, items.length)) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}

export class WorktreeGovernanceService {
  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly terminalStateService?: TerminalStateService,
    private readonly policy: WorktreeGovernancePolicy = DEFAULT_WORKTREE_GOVERNANCE_POLICY,
  ) {}

  getPolicy(): WorktreeGovernancePolicy {
    return { ...this.policy };
  }

  private isAgentRunning(session: TerminalSessionRecord): boolean {
    const state =
      this.terminalStateService?.getCurrent(session.id, session) ??
      session.terminalState;
    return state?.state === "agent_starting" || state?.state === "agent_running";
  }

  private lastActivityForSessions(
    sessions: TerminalSessionRecord[],
  ): string | null {
    let latestMs = -1;
    let latestIso: string | null = null;
    for (const session of sessions) {
      const candidate: Date | string | undefined =
        session.lastActivityAt ?? session.createdAt;
      if (!candidate) continue;
      const ms =
        candidate instanceof Date
          ? candidate.getTime()
          : Date.parse(candidate);
      if (Number.isFinite(ms) && ms > latestMs) {
        latestMs = ms;
        latestIso =
          candidate instanceof Date ? candidate.toISOString() : candidate;
      }
    }
    return latestIso;
  }

  async inspect(
    parentProjectId: string,
    options?: { includeDiskUsage?: boolean },
  ): Promise<WorktreeGovernanceResponse> {
    const parent = this.manager
      .listProjects()
      .find((project) => project.id === parentProjectId);
    if (!parent) {
      throw new WorktreeProvisionError("Parent project not found", 404);
    }
    if (!parent.path) {
      throw new WorktreeProvisionError("Parent project path unavailable", 409);
    }
    const parentPath = await realpath(parent.path).catch(() => null);
    if (!parentPath) {
      throw new WorktreeProvisionError("Parent project path unavailable", 409);
    }

    const [contexts, porcelainOutput, base] = await Promise.all([
      this.manager.refreshProjectContexts(parentProjectId),
      worktreeGit(parentPath, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]).catch(() => ""),
      resolveBaseRef(parentPath, parent.mainBranch),
    ]);

    const porcelain = parsePorcelainWorktrees(porcelainOutput);
    const prunable: PrunableWorktreeRecord[] = porcelain
      .filter((entry) => entry.prunable !== null)
      .map((entry) => ({
        worktreePath: entry.worktreePath,
        branch: entry.branch,
        reason: entry.prunable ?? "gitdir missing",
      }));

    const sessions = this.manager.listSessions();
    const sessionsByProjectId = new Map<string, TerminalSessionRecord[]>();
    for (const session of sessions) {
      const list = sessionsByProjectId.get(session.projectId);
      if (list) list.push(session);
      else sessionsByProjectId.set(session.projectId, [session]);
    }

    const children = (contexts ?? []).filter(
      (context) =>
        !context.isPrimary &&
        context.availability === "available" &&
        Boolean(context.path),
    );

    const nowMs = Date.now();
    const staleThresholdMs = this.policy.staleDays * DAY_MS;

    const inspected = await mapWithConcurrency(
      children,
      4,
      async (context: TerminalProjectContextRecord): Promise<WorktreeGovernanceItem> => {
        const contextPath = context.path!;
        const contextSessions = sessionsByProjectId.get(context.projectId) ?? [];
        const runningAgentCount = contextSessions.filter((s) =>
          this.isAgentRunning(s),
        ).length;
        const sessionLastActivityAt = this.lastActivityForSessions(contextSessions);
        const [dirty, mergedIntoBase, fsActivityMs] = await Promise.all([
          inspectDirtyStatus(contextPath),
          checkMergedIntoBase(parentPath, context.head, base.baseCommit),
          estimateWorktreeFilesystemActivityMs(contextPath),
        ]);

        const sessionActivityMs = sessionLastActivityAt
          ? Date.parse(sessionLastActivityAt)
          : NaN;
        const latestActivityMs = Math.max(
          Number.isFinite(sessionActivityMs) ? sessionActivityMs : -1,
          fsActivityMs ?? -1,
        );
        const lastActivityAt =
          latestActivityMs > 0 ? new Date(latestActivityMs).toISOString() : null;

        const isRunning = runningAgentCount > 0;
        const isMerged = mergedIntoBase === true;
        const isStale =
          !isRunning &&
          !dirty.isDirty &&
          latestActivityMs > 0 &&
          nowMs - latestActivityMs >= staleThresholdMs;

        // Pinned worktrees are never folded or auto-deleted, but clean idle ones CAN be recycled.
        const canRecycle = !isRunning && !dirty.isDirty && isMerged;
        const canShareParallel = true;

        let bucket: WorktreeGovernanceBucket;
        let canSafeDelete = false;
        let canForceDeleteWithConfirm = false;
        let blockReason: string | null = null;

        if (context.pinned) {
          bucket = "pinned";
          canSafeDelete = false;
          canForceDeleteWithConfirm = false;
          blockReason = "已置顶保护（不折叠、不自动删除，空闲干净时可复用）";
        } else if (isRunning) {
          bucket = "active";
          canSafeDelete = false;
          canForceDeleteWithConfirm = false;
          blockReason = "存在运行中 Agent";
        } else if (dirty.isDirty) {
          bucket = "dirty_abandoned";
          canSafeDelete = false;
          canForceDeleteWithConfirm = true;
          blockReason = "存在未提交或未跟踪改动";
        } else if (isMerged && isStale) {
          bucket = "cleanable_stale";
          canSafeDelete = true;
          canForceDeleteWithConfirm = false;
        } else if (isMerged) {
          bucket = "cleanable_merged";
          canSafeDelete = true;
          canForceDeleteWithConfirm = false;
        } else {
          bucket = "active";
          canSafeDelete = false;
          canForceDeleteWithConfirm = false;
          blockReason =
            mergedIntoBase === null
              ? "无法确认是否已合入主分支"
              : context.branch
                ? "仍有未合入主分支的提交"
                : "Detached HEAD 含未合入提交";
        }

        return {
          projectId: context.projectId,
          name: context.name,
          branch: context.branch,
          head: context.head,
          pinned: context.pinned,
          bucket,
          isDirty: dirty.isDirty,
          dirtyPreviewFiles: dirty.dirtyPreviewFiles,
          changedFilesCount: dirty.changedFilesCount,
          untrackedFilesCount: dirty.untrackedFilesCount,
          mergedIntoBase,
          prState: "unknown",
          prNumber: null,
          prUrl: null,
          runningAgentCount,
          terminalCount: contextSessions.length,
          lastActivityAt,
          diskUsageBytes: null,
          canSafeDelete,
          canForceDeleteWithConfirm,
          canRecycle,
          canShareParallel,
          blockReason,
        };
      },
    );

    // Promote the top maxIdleWorktrees most recently active unpinned clean merged items to idle_hot_slot.
    if (this.policy.maxIdleWorktrees > 0) {
      const mergedUnpinned = inspected
        .filter((item) => item.bucket === "cleanable_merged")
        .sort((a, b) => {
          const aMs = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
          const bMs = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
          return bMs - aMs || a.name.localeCompare(b.name);
        });
      for (const hot of mergedUnpinned.slice(0, this.policy.maxIdleWorktrees)) {
        hot.bucket = "idle_hot_slot";
      }
    }

    if (options?.includeDiskUsage) {
      const pathById = new Map(
        children.map((context) => [context.projectId, context.path!]),
      );
      await mapWithConcurrency(inspected, 2, async (item) => {
        const dir = pathById.get(item.projectId);
        if (!dir) return;
        item.diskUsageBytes = await estimateDiskUsageBytes(dir);
      });
    }

    // Check if any parent path escapes were missed — order deterministically:
    // pinned -> active -> dirty_abandoned -> idle_hot_slot -> cleanable_merged -> cleanable_stale
    const order: Record<WorktreeGovernanceBucket, number> = {
      pinned: 0,
      active: 1,
      dirty_abandoned: 2,
      idle_hot_slot: 3,
      cleanable_merged: 4,
      cleanable_stale: 5,
    };
    inspected.sort(
      (a, b) => order[a.bucket] - order[b.bucket] || a.name.localeCompare(b.name),
    );

    return {
      parentProjectId,
      baseRef: base.baseRef,
      generatedAt: new Date().toISOString(),
      items: inspected,
      prunable,
      policy: this.getPolicy(),
    };
  }

  async buildCreatePreviewSupplements(parentProjectId: string): Promise<{
    recyclableSlots: RecyclableWorktreeSlot[];
    shareableContexts: ShareableWorktreeContext[];
    unpinnedWorktreeCount: number;
    maxUnpinnedSoftLimit: number;
  }> {
    const governance = await this.inspect(parentProjectId, {
      includeDiskUsage: false,
    });
    // Prefer pinned clean slots and hottest unpinned clean slots first.
    const recyclableSlots: RecyclableWorktreeSlot[] = governance.items
      .filter((item) => item.canRecycle)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const aMs = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
        const bMs = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
        return bMs - aMs || a.name.localeCompare(b.name);
      })
      .map((item) => ({
        childProjectId: item.projectId,
        name: item.name,
        branch: item.branch,
        pinned: item.pinned,
        lastActivityAt: item.lastActivityAt,
        prState: item.prState,
      }));

    const shareableContexts: ShareableWorktreeContext[] = governance.items
      .filter((item) => item.canShareParallel)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if ((a.runningAgentCount > 0) !== (b.runningAgentCount > 0)) {
          return a.runningAgentCount > 0 ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((item) => ({
        projectId: item.projectId,
        name: item.name,
        branch: item.branch,
        pinned: item.pinned,
        runningAgentCount: item.runningAgentCount,
        isDirty: item.isDirty,
      }));

    return {
      recyclableSlots,
      shareableContexts,
      unpinnedWorktreeCount: governance.items.filter((item) => !item.pinned)
        .length,
      maxUnpinnedSoftLimit: this.policy.maxUnpinnedSoftLimit,
    };
  }
}

export function isDirectWorktreeChild(
  parentPath: string,
  worktreePath: string,
): boolean {
  const rel = path.relative(path.join(parentPath, ".worktree"), worktreePath);
  return (
    rel.length > 0 &&
    rel !== "." &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel) &&
    path.dirname(rel) === "."
  );
}
