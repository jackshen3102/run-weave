import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseTerminalChildProjectId,
  type RecycleWorktreeRequest,
  type RecycleWorktreeResponse,
} from "@runweave/shared/terminal/project-context";
import { resolveRepositoryIdentity } from "../../repository/identity";
import {
  createTerminalSession,
  type TerminalSessionCreationOptions,
} from "../application/create-session";
import { deleteTerminalSession } from "../application/delete-session";
import { toProjectContextPayload } from "../application/payloads";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { clearPreviewFileSearchCache } from "../preview/preview";
import {
  recordTerminalSessionDeleted,
  type TerminalActivityDependencies,
} from "../runtime/activity-events";
import { terminalInputAdmission } from "../runtime/input-admission";
import type { TerminalEventService } from "../state/terminal-event-service";
import type { TerminalStateService } from "../state/terminal-state-service";
import { WorkspaceServiceConfigLoader } from "./config";
import { approveSetup, setupRevision } from "./setup-approvals";
import { startWorktreeTerminal } from "./setup-terminal";
import {
  checkMergedIntoBase,
  isDirectWorktreeChild,
  parsePorcelainWorktrees,
} from "./worktree-governance";
import {
  WorktreeProvisionError,
  WorktreeProvisioner,
  worktreeGit,
} from "./worktree-provisioner";

export interface WorktreeRecycleOptions extends TerminalSessionCreationOptions {
  terminalStateService?: TerminalStateService;
  terminalEventService?: TerminalEventService;
  activity?: TerminalActivityDependencies;
}

export class WorktreeRecycleService {
  private readonly loader = new WorkspaceServiceConfigLoader();
  private readonly receipts = new Map<
    string,
    { request: string; result: RecycleWorktreeResponse; expires: number }
  >();

  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly options: WorktreeRecycleOptions,
  ) {}

  private isAgentRunning(session: TerminalSessionRecord): boolean {
    const state =
      this.options.terminalStateService?.getCurrent(session.id, session) ??
      session.terminalState;
    return state?.state === "agent_starting" || state?.state === "agent_running";
  }

  private async loadSetup(directory: string) {
    const loaded = await this.loader.load(directory, {
      forWorktreeSetup: true,
    });
    return "setup" in loaded ? loaded.setup : undefined;
  }

  async recycle(
    parentProjectId: string,
    childProjectId: string,
    request: RecycleWorktreeRequest,
  ): Promise<RecycleWorktreeResponse> {
    const parsed = parseTerminalChildProjectId(childProjectId);
    if (!parsed || parsed.parentProjectId !== parentProjectId) {
      throw new WorktreeProvisionError(
        "Worktree does not belong to this Project",
        404,
      );
    }
    const parent = this.manager
      .listProjects()
      .find((project) => project.id === parentProjectId);
    if (!parent) {
      throw new WorktreeProvisionError("Parent project not found", 404);
    }
    if (!parent.path) {
      throw new WorktreeProvisionError("Parent project path unavailable", 409);
    }
    const identity = await resolveRepositoryIdentity(parent.path).catch(() => {
      throw new WorktreeProvisionError("Git repository required", 409);
    });
    const parentPath = await realpath(parent.path);
    if (identity.worktreeRoot !== parentPath) {
      throw new WorktreeProvisionError(
        "Parent project must be a Git working tree root",
        409,
      );
    }

    const release = await WorktreeProvisioner.acquireParent(parentPath);
    try {
      for (const [key, receipt] of this.receipts) {
        if (receipt.expires <= Date.now()) this.receipts.delete(key);
      }
      const receiptKey = JSON.stringify([
        parentProjectId,
        childProjectId,
        request.operationId,
      ]);
      const payloadDigest = JSON.stringify(request);
      const prior = this.receipts.get(receiptKey);
      if (prior) {
        if (prior.request !== payloadDigest) {
          throw new WorktreeProvisionError(
            "Operation ID already used for another request",
            409,
          );
        }
        return prior.result;
      }

      const branch = request.newBranch.trim();
      if (
        !branch ||
        branch.startsWith("-") ||
        (
          await worktreeGit(parentPath, [
            "check-ref-format",
            "--branch",
            branch,
          ]).catch(() => "")
        ).trimEnd() !== branch
      ) {
        throw new WorktreeProvisionError("Invalid Git branch", 400);
      }

      const contexts =
        await this.manager.refreshProjectContexts(parentProjectId);
      const context = contexts?.find(
        (candidate) => candidate.projectId === childProjectId,
      );
      if (!context || context.isPrimary) {
        throw new WorktreeProvisionError("Worktree not found", 404);
      }
      if (context.availability !== "available" || !context.path) {
        throw new WorktreeProvisionError(
          "Worktree path is unavailable",
          409,
        );
      }
      const worktreePath = await realpath(context.path).catch(() => null);
      if (!worktreePath || !isDirectWorktreeChild(parentPath, worktreePath)) {
        throw new WorktreeProvisionError(
          "Worktree path is outside the managed Project path",
          403,
        );
      }
      if (
        path.basename(worktreePath).normalize("NFC") !== parsed.worktreeName
      ) {
        throw new WorktreeProvisionError("Worktree identity mismatch", 409);
      }

      const targetSessions = this.manager
        .listSessions()
        .filter((session) => session.projectId === childProjectId);
      for (const session of targetSessions) {
        if (this.isAgentRunning(session)) {
          throw new WorktreeProvisionError(
            "Worktree has a running Agent session; open a parallel terminal on the current branch instead of recycling",
            409,
          );
        }
      }

      const statusOutput = await worktreeGit(worktreePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (statusOutput.length > 0) {
        throw new WorktreeProvisionError(
          "Worktree has uncommitted or untracked changes and cannot be recycled",
          409,
        );
      }

      const porcelain = parsePorcelainWorktrees(
        await worktreeGit(parentPath, ["worktree", "list", "--porcelain", "-z"]),
      );
      let registeredSelf: (typeof porcelain)[number] | null = null;
      for (const entry of porcelain) {
        const entryReal = await realpath(entry.worktreePath).catch(() => null);
        if (entryReal === worktreePath) {
          registeredSelf = entry;
          continue;
        }
        if (entry.branch === branch) {
          throw new WorktreeProvisionError(
            `Branch "${branch}" is already checked out in another Worktree`,
            409,
          );
        }
      }
      if (!registeredSelf) {
        throw new WorktreeProvisionError(
          "Worktree is not registered under this Project",
          409,
        );
      }

      const baseRef = request.baseRef.trim();
      if (request.fetchBase !== false && baseRef.startsWith("origin/")) {
        const remoteBranch = baseRef.slice("origin/".length);
        if (remoteBranch && !remoteBranch.startsWith("-")) {
          await worktreeGit(parentPath, [
            "fetch",
            "--no-tags",
            "origin",
            remoteBranch,
          ]).catch(() => undefined);
        }
      }
      const baseCommit = await WorktreeProvisioner.resolveCommit(
        parentPath,
        baseRef,
      );

      const shallow = (
        await worktreeGit(parentPath, [
          "rev-parse",
          "--is-shallow-repository",
        ]).catch(() => "")
      ).trim();
      if (shallow === "true") {
        throw new WorktreeProvisionError(
          "Cannot confirm merged commit ancestry in a shallow repository; create a new branch without recycling",
          409,
        );
      }

      const currentMerged = await checkMergedIntoBase(
        parentPath,
        registeredSelf.head,
        baseCommit,
      );
      if (currentMerged !== true) {
        throw new WorktreeProvisionError(
          "Worktree currently has unmerged commits and cannot be recycled; open a parallel terminal or merge first",
          409,
        );
      }

      const existingTargetCommit = (
        await worktreeGit(parentPath, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `refs/heads/${branch}^{commit}`,
        ]).catch(() => "")
      ).trim();
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(existingTargetCommit)) {
        const targetMerged = await checkMergedIntoBase(
          parentPath,
          existingTargetCommit,
          baseCommit,
        );
        if (targetMerged !== true) {
          throw new WorktreeProvisionError(
            `Branch "${branch}" already exists with unmerged commits and cannot be reset by recycling`,
            409,
          );
        }
      }

      const previousBranch =
        registeredSelf.branch && registeredSelf.branch !== branch
          ? registeredSelf.branch
          : null;

      await worktreeGit(worktreePath, [
        "-c",
        "core.hooksPath=" +
          (process.platform === "win32" ? "NUL" : "/dev/null"),
        "checkout",
        "-B",
        branch,
        baseCommit,
      ]).catch((error: { stderr?: string }) => {
        throw new WorktreeProvisionError(
          error.stderr?.trim() || "Git refused to reset Worktree branch",
          409,
        );
      });

      let previousBranchDeleted = false;
      if (request.deletePreviousBranch !== false && previousBranch) {
        try {
          await worktreeGit(parentPath, ["branch", "-d", "--", previousBranch]);
          previousBranchDeleted = true;
        } catch {
          previousBranchDeleted = false;
        }
      }

      clearPreviewFileSearchCache(childProjectId);

      if (request.closeIdleTerminals !== false && targetSessions.length > 0) {
        for (const session of targetSessions) {
          await deleteTerminalSession(session.id, {
            ...this.options,
            terminalSessionManager: this.manager,
          });
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

      const updatedContexts =
        await this.manager.refreshProjectContexts(parentProjectId);
      const updatedContext = updatedContexts?.find(
        (candidate) => candidate.projectId === childProjectId,
      );
      if (!updatedContext) {
        throw new WorktreeProvisionError(
          "Worktree recycled but unavailable in context registry",
          409,
        );
      }

      const actualSetup = request.runSetup
        ? await this.loadSetup(worktreePath)
        : undefined;
      const actualRevision =
        actualSetup && setupRevision(identity.repositoryId, actualSetup);
      const approved = Boolean(
        request.runSetup &&
          actualRevision &&
          actualRevision === request.approvedSetupRevision,
      );
      const mismatch = request.runSetup === true && !approved;
      if (approved && actualRevision) {
        await approveSetup(identity.repositoryId, actualRevision);
      }

      let inputChanged = () => true;
      const session = await createTerminalSession(
        this.manager,
        { projectId: updatedContext.projectId, cwd: worktreePath },
        {
          ...this.options,
          strictDefaultPanel: true,
          onSessionCreated: async (sessionId) => {
            const record = this.manager.getSession(sessionId)!;
            const admission = terminalInputAdmission(record);
            const initial = admission.inputWriteRevision;
            inputChanged = () => admission.inputWriteRevision !== initial;
          },
        },
      );
      if (!mismatch) {
        await startWorktreeTerminal(
          this.manager,
          session,
          this.options,
          approved ? actualSetup : undefined,
          request.launchAgent,
          inputChanged,
        );
      }

      const result: RecycleWorktreeResponse = {
        context: toProjectContextPayload(updatedContext),
        previousBranch,
        previousBranchDeleted,
        terminalSessionId: session.id,
        setupStatus: approved
          ? "running"
          : mismatch
            ? "revision_mismatch_skipped"
            : "skipped",
      };
      this.receipts.set(receiptKey, {
        request: payloadDigest,
        result,
        expires: Date.now() + 3_600_000,
      });
      return result;
    } finally {
      release();
    }
  }
}
