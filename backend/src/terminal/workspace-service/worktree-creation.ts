import { toProjectContextPayload } from "../application/payloads";
import { realpath } from "node:fs/promises";
import type {
  CreateWorktreeContextRequest,
  CreateWorktreeContextResponse,
  WorktreeCreatePreviewResponse,
} from "@runweave/shared/terminal/project-context";
import { resolveRepositoryIdentity } from "../../repository/identity";
import {
  createTerminalSession,
  type TerminalSessionCreationOptions,
} from "../application/create-session";
import type { TerminalSessionManager } from "../manager/manager";
import { terminalInputAdmission } from "../runtime/input-admission";
import { WorkspaceServiceConfigLoader } from "./config";
import {
  approveSetup,
  isSetupApproved,
  setupRevision,
} from "./setup-approvals";
import { startWorktreeTerminal } from "./setup-terminal";
import {
  WorktreeProvisioner,
  WorktreeProvisionError,
  worktreeGit,
} from "./worktree-provisioner";

export class WorktreeCreationService {
  private readonly loader = new WorkspaceServiceConfigLoader();
  private readonly receipts = new Map<
    string,
    { request: string; result: CreateWorktreeContextResponse; expires: number }
  >();
  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
  ) {}

  private parent(id: string) {
    const project = this.manager
      .listProjects()
      .find((candidate) => candidate.id === id);
    if (!project)
      throw new WorktreeProvisionError("Parent project not found", 404);
    if (!project.path)
      throw new WorktreeProvisionError("Parent project path unavailable");
    return { path: project.path, mainBranch: project.mainBranch };
  }

  private async identity(directory: string) {
    const identity = await resolveRepositoryIdentity(directory).catch(() => {
      throw new WorktreeProvisionError("Git repository required");
    });
    if (identity.worktreeRoot !== (await realpath(directory)))
      throw new WorktreeProvisionError(
        "Parent project must be a Git working tree root",
      );
    return identity;
  }

  private async setup(directory: string) {
    const loaded = await this.loader.load(directory);
    return "setup" in loaded ? loaded.setup : undefined;
  }

  async preview(id: string): Promise<WorktreeCreatePreviewResponse> {
    const parent = this.parent(id);
    const { repositoryId } = await this.identity(parent.path);
    const [setup, remote, current, branches, contexts] = await Promise.all([
      this.setup(parent.path),
      worktreeGit(parent.path, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]).catch(() => ""),
      worktreeGit(parent.path, ["branch", "--show-current"]),
      worktreeGit(parent.path, [
        "for-each-ref",
        "--format=%(refname:strip=2)",
        "refs/heads",
      ]),
      this.manager.refreshProjectContexts(id),
    ]);
    const revision = setup && setupRevision(repositoryId, setup);
    return {
      parentProjectId: id,
      defaultBaseRef: parent.mainBranch || remote.trim() || "HEAD",
      currentBranch: current.trim() || null,
      branches: branches.trim().split("\n").filter(Boolean),
      worktreeNames:
        contexts?.filter((c) => !c.isPrimary).map((c) => c.name) ?? [],
      setup:
        setup && revision
          ? {
              command: setup.command,
              cwd: setup.cwd,
              revision,
              approved: await isSetupApproved(repositoryId, revision),
            }
          : null,
    };
  }

  async create(
    id: string,
    request: CreateWorktreeContextRequest,
  ): Promise<CreateWorktreeContextResponse> {
    const parent = this.parent(id);
    const { worktreeRoot, repositoryId } = await this.identity(parent.path);
    const release = await WorktreeProvisioner.acquireParent(worktreeRoot);
    try {
      for (const [key, receipt] of this.receipts)
        if (receipt.expires <= Date.now()) this.receipts.delete(key);
      const key = JSON.stringify([id, request.operationId]);
      const payload = JSON.stringify(request);
      const prior = this.receipts.get(key);
      if (prior) {
        if (prior.request !== payload)
          throw new WorktreeProvisionError(
            "Operation ID already used for another request",
          );
        return prior.result;
      }
      if (this.parent(id).path !== parent.path)
        throw new WorktreeProvisionError("Parent project changed");
      const commit = await WorktreeProvisioner.resolveCommit(
        worktreeRoot,
        request.baseRef,
      );
      const directory = await WorktreeProvisioner.add(
        worktreeRoot,
        request.name,
        request.branch ?? request.name,
        commit,
        request.checkoutExistingBranch,
      );
      const contexts = await this.manager.refreshProjectContexts(id);
      const context = contexts?.find(
        (c) =>
          c.path === directory &&
          !c.isPrimary &&
          c.availability === "available",
      );
      if (!context)
        throw new WorktreeProvisionError(
          "Worktree created but unavailable in the context registry",
        );
      // Re-open the checked out file (O_NOFOLLOW), never reuse the parent preview.
      const actual = await this.setup(directory);
      const actualRevision = actual && setupRevision(repositoryId, actual);
      const approved = Boolean(
        request.runSetup &&
        actualRevision &&
        actualRevision === request.approvedSetupRevision,
      );
      const mismatch = request.runSetup === true && !approved;
      if (approved && actualRevision)
        await approveSetup(repositoryId, actualRevision);
      let inputChanged = () => true;
      try {
        const session = await createTerminalSession(
          this.manager,
          { projectId: context.projectId, cwd: directory },
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
        if (!mismatch)
          await startWorktreeTerminal(
            this.manager,
            session,
            this.options,
            approved ? actual : undefined,
            request.launchAgent,
            inputChanged,
          );
        const result: CreateWorktreeContextResponse = {
          context: toProjectContextPayload(context),
          terminalSessionId: session.id,
          setupStatus: approved
            ? "running"
            : mismatch
              ? "revision_mismatch_skipped"
              : "skipped",
        };
        this.receipts.set(key, {
          request: payload,
          result,
          expires: Date.now() + 3_600_000,
        });
        return result;
      } catch (error) {
        throw new WorktreeProvisionError(
          "Worktree created. Open it from the context list. Terminal startup failed: " +
            (error instanceof Error ? error.message : String(error)),
          503,
        );
      }
    } finally {
      release();
    }
  }
}
