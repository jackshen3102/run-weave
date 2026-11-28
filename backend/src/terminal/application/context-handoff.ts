import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { settingText } from "@runweave/config-node";
import type {
  CreateTerminalContextHandoffRequest as Request,
  CreateTerminalContextHandoffResponse as Result,
  HandoffContextScope,
  HandoffPlacement,
  TerminalContextHandoffPreview,
} from "@runweave/shared/terminal/context-handoff";
import { applyPlanFilesToHandoffDocument } from "@runweave/shared/terminal/handoff-budgeter";
import type { TerminalTextAttachmentDelivery } from "../attachments/text-attachment-delivery";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { isInteractiveShellLaunch } from "../tmux/output-watcher-helpers";
import { TerminalAgentForkService } from "./agent-fork";
import { prepareTerminalAgent } from "./agent-preparation";
import { readTerminalConversation } from "./conversation";
import {
  createTerminalSession,
  type TerminalSessionCreationOptions,
} from "./create-session";
import { handoffSnapshot } from "./handoff-budgeter";
import { deliverHandoff } from "./handoff-delivery";
import { detectPlanFiles, validatePlanFilePaths } from "./handoff-plan-files";
import { getSessionOrThrow, TerminalPanelError } from "./panel-common";

export class HandoffConflict extends TerminalPanelError {
  constructor(
    readonly code: string,
    message: string,
    details?: {
      terminalSessionId: string;
      panelId?: string;
      placement?: HandoffPlacement;
    },
  ) {
    super(409, message, details);
  }
}

function evaluateInPlaceEligibility(
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord | undefined,
  tmuxAvailable: boolean,
): { canInPlaceHandoff: boolean; inPlaceUnavailableReason: string | null } {
  if (session.runtimeKind !== "tmux" || !tmuxAvailable) {
    return {
      canInPlaceHandoff: false,
      inPlaceUnavailableReason: "当前终端未使用 tmux，仅支持交接到新终端",
    };
  }
  if (!isInteractiveShellLaunch(session.command, session.args)) {
    return {
      canInPlaceHandoff: false,
      inPlaceUnavailableReason:
        "当前终端启动命令不是持久交互式 Shell，仅支持交接到新终端",
    };
  }
  if (!panel || panel.status !== "running" || !panel.tmuxPaneId) {
    return {
      canInPlaceHandoff: false,
      inPlaceUnavailableReason: "当前终端面板不可用，仅支持交接到新终端",
    };
  }
  if (
    panel.terminalState?.state === "agent_running" ||
    panel.terminalState?.state === "agent_starting"
  ) {
    return {
      canInPlaceHandoff: false,
      inPlaceUnavailableReason:
        "当前 Agent 正在执行中，请等待空闲后再原位切换，或改用交接到新终端",
    };
  }
  return { canInPlaceHandoff: true, inPlaceUnavailableReason: null };
}
const changed = () =>
  new HandoffConflict(
    "handoff_source_changed",
    "来源会话已变化，请刷新交接预览",
  );

export class TerminalContextHandoffService {
  private readonly nativeFork: TerminalAgentForkService;
  private readonly operations = new Map<
    string,
    { fingerprint: string; result: Promise<Result>; expires: number }
  >();
  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly options: TerminalSessionCreationOptions,
    private readonly attachments?: TerminalTextAttachmentDelivery,
  ) {
    this.nativeFork = new TerminalAgentForkService(manager, options, true);
  }

  private async snapshot(
    id: string,
    expectedPanel?: string,
    expectedThreadId?: string,
  ) {
    const session = getSessionOrThrow(this.manager, id);
    const projectId = session.projectId;
    const currentPanel = () =>
      this.manager.getPanelWorkspace(id)?.activePanelId ?? "default";
    const panelId = currentPanel();
    if (expectedPanel && panelId !== expectedPanel) throw changed();
    const cwd = this.manager.getPanel(panelId)?.cwd ?? session.cwd;
    const contexts = await this.manager.refreshProjectContexts(
      this.manager.resolveParentProjectId(projectId),
    );
    const conversation = await readTerminalConversation(
      this.manager,
      id,
      {
        panelId: panelId === "default" ? undefined : panelId,
        expectedThreadId,
        handoffCwd: cwd,
      },
      AbortSignal.timeout(25_000),
      this.options.tmuxService,
    );
    if (
      currentPanel() !== panelId ||
      this.manager.getSession(id)?.projectId !== projectId ||
      (this.manager.getPanel(panelId)?.cwd ?? session.cwd) !== cwd
    )
      throw changed();
    const target = conversation.target;
    if (!target || conversation.availability !== "available")
      throw new TerminalPanelError(409, "当前面板没有可读取的来源会话");
    const { document, coverage, revision } = handoffSnapshot(
      conversation,
      target.provider,
      target.threadId,
      cwd,
    );
    const native =
      target.provider === "codex"
        ? await this.nativeFork.target(id).catch(() => null)
        : null;
    const tmuxAvailable = Boolean(
      this.options.tmuxService && (await this.options.tmuxService.isAvailable()),
    );
    const panel = this.manager.getPanel(panelId);
    const eligibility = evaluateInPlaceEligibility(session, panel, tmuxAvailable);
    const detectedPlanFiles = await detectPlanFiles(cwd, document);
    const preview: TerminalContextHandoffPreview = {
      sourceTerminalId: id,
      sourcePanelId: panelId,
      sourceThreadId: target.threadId,
      sourceProvider: target.provider,
      sourceProjectId: projectId,
      sourceRevision: createHash("sha256")
        .update(JSON.stringify([target, projectId, cwd, revision]))
        .digest("hex"),
      targetProjects: [
        { projectId, name: "当前工作区" },
        ...(contexts ?? [])
          .filter(
            (c) => c.projectId !== projectId && c.availability === "available",
          )
          .map((c) => ({ projectId: c.projectId, name: c.name })),
      ],
      canNativeCodexFork:
        native?.panelId === panelId && native.threadId === target.threadId,
      canInPlaceHandoff: eligibility.canInPlaceHandoff,
      inPlaceUnavailableReason: eligibility.inPlaceUnavailableReason,
      detectedPlanFiles,
      ...coverage,
    };
    return { preview, document, cwd, contexts, native, eligibility };
  }

  async preview(id: string) {
    return (await this.snapshot(id)).preview;
  }

  execute(id: string, request: Request): Promise<Result> {
    for (const [key, receipt] of this.operations)
      if (receipt.expires <= Date.now()) this.operations.delete(key);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([id, request]))
      .digest("hex");
    const previous = this.operations.get(request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new HandoffConflict(
          "handoff_operation_conflict",
          "操作 ID 已用于其他参数",
        );
      return previous.result;
    }
    if (this.operations.size >= 1024)
      throw new TerminalPanelError(503, "交接请求过多");
    const receipt = {
      fingerprint,
      result: this.create(id, request),
      expires: Infinity,
    };
    this.operations.set(request.operationId, receipt);
    void receipt.result
      .finally(() => {
        receipt.expires = Date.now() + 3_600_000;
      })
      .catch(() => undefined);
    return receipt.result;
  }

  private async create(id: string, request: Request): Promise<Result> {
    const source = await this.snapshot(
      id,
      request.panelId,
      request.expectedThreadId,
    );
    const { preview, native } = source;
    if (
      preview.sourceThreadId !== request.expectedThreadId ||
      preview.sourceRevision !== request.expectedSourceRevision
    )
      throw changed();
    const projectId = request.targetProjectId;
    if (
      this.manager.resolveParentProjectId(projectId) !==
      this.manager.resolveParentProjectId(preview.sourceProjectId)
    )
      throw new TerminalPanelError(403, "只能交接到同一父项目");
    const same = projectId === preview.sourceProjectId;
    const cwd = same
      ? source.cwd
      : source.contexts?.find(
          (c) => c.projectId === projectId && c.availability === "available",
        )?.path;
    if (!cwd) throw new TerminalPanelError(404, "目标工作区不可用");
    const { mode, targetAgent } = request;
    const placement: HandoffPlacement = request.placement ?? "new_terminal";
    const contextScope: HandoffContextScope =
      request.contextScope ?? "full_conversation";
    const planFilePaths = request.planFilePaths ?? [];
    if (contextScope === "plan_focused" && planFilePaths.length === 0) {
      throw new TerminalPanelError(400, "以计划为主交接时至少选择一份计划文件");
    }
    const planFiles =
      planFilePaths.length > 0
        ? await validatePlanFilePaths(source.cwd, planFilePaths)
        : [];
    const handoffDocument =
      mode === "portable_handoff"
        ? applyPlanFilesToHandoffDocument(source.document, {
            contextScope,
            planFiles,
          })
        : null;

    if (placement === "in_place") {
      if (!same) {
        throw new HandoffConflict(
          "handoff_in_place_requires_same_workspace",
          "跨工作区交接仅支持交接到新终端",
        );
      }
      if (mode === "native_fork") {
        throw new HandoffConflict(
          "handoff_in_place_incompatible_mode",
          "原位切换不支持 Codex 原生 Fork，请使用便携交接或交接到新终端",
        );
      }
      if (!source.eligibility.canInPlaceHandoff) {
        throw new HandoffConflict(
          "handoff_in_place_unavailable",
          source.eligibility.inPlaceUnavailableReason ??
            "当前面板暂不支持原位切换，请改用交接到新终端",
        );
      }
      if (
        !this.attachments ||
        !(await this.options.tmuxService?.isAvailable())
      ) {
        throw new TerminalPanelError(503, "终端附件或 tmux 服务不可用");
      }
      await assertManagedDirectory(this.attachments.files.root);

      const liveSession = getSessionOrThrow(this.manager, id);
      const livePanel = this.manager.getPanel(request.panelId);
      const liveEligibility = evaluateInPlaceEligibility(
        liveSession,
        livePanel,
        true,
      );
      if (
        liveSession.projectId !== preview.sourceProjectId ||
        (this.manager.getPanelWorkspace(id)?.activePanelId ?? "default") !==
          request.panelId
      ) {
        throw changed();
      }
      if (!liveEligibility.canInPlaceHandoff) {
        throw new HandoffConflict(
          "handoff_in_place_unavailable",
          liveEligibility.inPlaceUnavailableReason ??
            "当前面板暂不支持原位切换，请改用交接到新终端",
        );
      }

      let switchedInPlace = false;
      try {
        const started = await prepareTerminalAgent(
          this.manager,
          liveSession,
          this.options,
          {
            agent: targetAgent,
            panelId: request.panelId,
            cwd,
            command:
              targetAgent === "pi"
                ? "pi"
                : (settingText(`agents.${targetAgent}.binary`) ?? targetAgent),
            prompt: "",
          },
          {
            resetPanelBeforeLaunch: true,
            skipInitialPrompt: true,
            execInNewPane: false,
            onPanelRespawned: () => {
              switchedInPlace = true;
            },
          },
        );
        switchedInPlace = true;
        const handoffFilePath = await deliverHandoff(
          this.manager,
          this.options,
          this.attachments,
          getSessionOrThrow(this.manager, id),
          request.panelId,
          request,
          handoffDocument,
          started.operationId,
        );
        return {
          terminalSessionId: id,
          panelId: request.panelId,
          projectId,
          targetAgent,
          mode,
          placement,
          handoffFilePath,
          status: "delivered",
        };
      } catch (error) {
        if (switchedInPlace) {
          throw new HandoffConflict(
            "handoff_delivery_unconfirmed",
            "当前面板已切换为目标 Agent，但交接上下文投递未确认，请核对终端输出；原会话仍保留在本地历史中",
            {
              terminalSessionId: id,
              panelId: request.panelId,
              placement: "in_place",
            },
          );
        }
        throw error;
      }
    }

    let createdId: string | undefined;
    try {
      let panelId: string;
      let generation: string | undefined;
      if (mode === "native_fork") {
        if (
          !same ||
          targetAgent !== "codex" ||
          !preview.canNativeCodexFork ||
          !native
        )
          throw changed();
        const result = await this.nativeFork.fork(
          id,
          {
            panelId: native.panelId,
            operationId: request.operationId,
            expectedThreadId: native.threadId,
            expectedRevision: native.revision,
          },
          {
            type: "terminal",
            terminalSessionId: id,
            relation: "context-handoff",
          },
        );
        createdId = result.terminalSessionId;
        panelId = result.panelId;
        if (!request.prompt)
          return {
            terminalSessionId: createdId,
            panelId,
            mode,
            placement,
            targetAgent,
            projectId,
            handoffFilePath: null,
            status: "starting",
          };
      } else {
        if (
          !this.attachments ||
          !(await this.options.tmuxService?.isAvailable())
        )
          throw new TerminalPanelError(503, "终端附件或 tmux 服务不可用");
        await assertManagedDirectory(this.attachments.files.root);
        if (
          getSessionOrThrow(this.manager, id).projectId !==
            preview.sourceProjectId ||
          (this.manager.getPanelWorkspace(id)?.activePanelId ?? "default") !==
            request.panelId
        )
          throw changed();
        const session = await createTerminalSession(
          this.manager,
          { projectId, cwd, runtimePreference: "tmux" },
          { ...this.options, strictDefaultPanel: true },
          {
            type: "terminal",
            terminalSessionId: id,
            relation: "context-handoff",
          },
        );
        createdId = session.id;
        const workspace = this.manager.getPanelWorkspace(session.id);
        if (!workspace?.activePanelId) throw new Error("新面板尚未就绪");
        panelId = workspace.activePanelId;
        const started = await prepareTerminalAgent(
          this.manager,
          session,
          this.options,
          {
            agent: targetAgent,
            panelId,
            cwd,
            command:
              targetAgent === "pi"
                ? "pi"
                : (settingText(`agents.${targetAgent}.binary`) ?? targetAgent),
            prompt: "",
          },
          { skipInitialPrompt: true, execInNewPane: true },
        );
        generation = started.operationId;
      }
      const handoffFilePath = await deliverHandoff(
        this.manager,
        this.options,
        this.attachments!,
        getSessionOrThrow(this.manager, createdId),
        panelId,
        request,
        handoffDocument,
        generation,
      );
      return {
        terminalSessionId: createdId,
        panelId,
        projectId,
        targetAgent,
        mode,
        placement,
        handoffFilePath,
        status: "delivered",
      };
    } catch (error) {
      const details =
        error instanceof TerminalPanelError
          ? (error.details as { terminalSessionId?: string })
          : undefined;
      const terminalSessionId = createdId ?? details?.terminalSessionId;
      if (terminalSessionId)
        throw new HandoffConflict(
          "handoff_delivery_unconfirmed",
          "交接投递未确认，请核对新终端",
          { terminalSessionId, placement: "new_terminal" },
        );
      throw error;
    }
  }
}

async function assertManagedDirectory(root: string) {
  // A custom instance data directory may itself be inside a checkout.
  let directory = await realpath(root);
  while (true) {
    if (
      path.basename(directory) === ".git" ||
      (await lstat(path.join(directory, ".git")).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      ))
    )
      throw new TerminalPanelError(409, "受管附件目录位于 Git 工作区内");
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
