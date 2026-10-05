import type {
  SendTerminalInputRequest,
  SendTerminalInputResponse,
} from "@runweave/shared/terminal/input";
import {
  TERMINAL_TEXT_ATTACHMENT_LIMITS as limits,
  type CreateTerminalTextAttachmentRequest,
  type InsertTerminalTextAttachmentRequest,
  type TerminalTextAttachmentCapability,
  type TerminalTextAttachmentOperation,
} from "@runweave/shared/terminal/text-attachments";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import type { TerminalRuntimeRegistry } from "../runtime/registry";
import type { PtyService } from "../runtime/pty-service";
import type { TmuxPaneTarget, TmuxService } from "../tmux/service";
import { resolveTmuxTarget } from "../runtime/launcher";
import {
  beginTextAttachmentDelivery,
  terminalInputAdmission,
} from "../runtime/input-admission";
import {
  pasteTextAttachmentReference,
  sendInputToSession,
} from "../application/input-dispatcher";
import {
  attachmentFingerprint,
  TerminalTextAttachmentService,
  TextAttachmentError,
} from "./text-attachment-service";

type Target = {
  session: TerminalSessionRecord;
  panel: TerminalPanelRecord;
  pane: TmuxPaneTarget;
  threadId: string | null;
};

export class TerminalTextAttachmentDelivery {
  private closed = false;
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.inflight.values()].map((entry) => entry.result),
    );
    this.bindings.clear();
  }
  private readonly bindings = new Map<
    string,
    { revision: object; target: Target }
  >();
  private readonly inflight = new Map<
    string,
    { fingerprint: string; result: Promise<unknown> }
  >();
  constructor(
    readonly files: TerminalTextAttachmentService,
    private readonly manager: TerminalSessionManager,
    private readonly tmux: TmuxService,
    private readonly registry: TerminalRuntimeRegistry,
    private readonly pty: PtyService,
  ) {}

  private target(
    sessionId: string,
    panelId: string,
  ): Target {
    const session = this.manager.getSession(sessionId);
    const panel = this.manager.getPanel(panelId);
    if (
      !session ||
      !panel ||
      panel.terminalSessionId !== sessionId ||
      session.runtimeKind !== "tmux" ||
      session.status !== "running" ||
      panel.status !== "running" ||
      this.manager.getPanelWorkspace(sessionId)?.activePanelId !== panelId
    )
      throw new TextAttachmentError(409, "终端面板已切换或退出，原文已保留");
    return {
      session,
      panel,
      pane: {
        ...resolveTmuxTarget(session, this.tmux),
        paneId: panel.tmuxPaneId,
      },
      threadId: panel.threadId ?? panel.lastThreadId ?? null,
    };
  }
  private recheck(target: Target, active = true): void {
    const panel = this.manager.getPanel(target.panel.id);
    if (
      this.manager.getSession(target.session.id) !== target.session ||
      target.session.status !== "running" ||
      panel !== target.panel ||
      panel.status !== "running" ||
      panel.tmuxPaneId !== target.pane.paneId ||
      (active &&
        this.manager.getPanelWorkspace(target.session.id)?.activePanelId !==
          panel.id)
    )
      throw new TextAttachmentError(409, "附件目标已变化，未插入路径");
  }
  async capability(
    sessionId: string,
    panelId: string,
  ): Promise<TerminalTextAttachmentCapability> {
    try {
      const target = this.target(sessionId, panelId);
      this.recheck(target);
      return {
        enabled: true,
        provider: null,
        threadId: target.threadId,
        executionHost: "backend-local",
        reason: null,
        limits,
      };
    } catch (error) {
      return {
        enabled: false,
        provider: null,
        threadId: null,
        executionHost: null,
        reason:
          error instanceof TextAttachmentError
            ? error.message
            : "终端当前不可用",
        limits,
      };
    }
  }
  private once<T>(
    sessionId: string,
    operationId: string,
    request: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new TextAttachmentError(503, "附件服务已关闭");
    const key = `${sessionId}:${operationId}`;
    const fingerprint = attachmentFingerprint(request);
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new TextAttachmentError(409, "operationId 已用于其他请求");
      return pending.result as Promise<T>;
    }
    const result = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, { fingerprint, result });
    return result;
  }
  create(sessionId: string, request: CreateTerminalTextAttachmentRequest) {
    // Capture before any asynchronous verification or file write.
    let target:
      | ReturnType<TerminalTextAttachmentDelivery["target"]>
      | undefined;
    let targetError: unknown;
    try {
      target = this.target(
        sessionId,
        request.panelId,
      );
    } catch (error) {
      targetError = error;
    }
    const revision = target && terminalInputAdmission(target.session).revision;
    return this.once(sessionId, request.operationId, request, async () => {
      const previous = await this.previous(
        sessionId,
        request.operationId,
        attachmentFingerprint(request),
      );
      if (previous) return this.files.create(sessionId, request);
      if (!target || !revision) throw targetError;
      this.recheck(target);
      const attachment = await this.files.create(sessionId, request);
      // Never renew an old create's revision on replay.
      if (!previous && !this.bindings.has(attachment.id))
        this.bindings.set(attachment.id, { revision, target });
      return attachment;
    });
  }
  insert(
    sessionId: string,
    id: string,
    request: InsertTerminalTextAttachmentRequest,
  ): Promise<TerminalTextAttachmentOperation> {
    const payload = { id, ...request };
    return this.once(sessionId, request.operationId, payload, async () => {
      const fingerprint = attachmentFingerprint(payload);
      const previous = await this.previous(
        sessionId,
        request.operationId,
        fingerprint,
      );
      if (previous) return previous;
      const attachment = await this.files.get(sessionId, id);
      if (
        attachment.purpose !== "tui" ||
        request.operationId !== attachment.insertOperationId ||
        attachment.panelId !== request.panelId
      )
        throw new TextAttachmentError(409, "附件目标或插入操作不匹配");
      const binding = this.bindings.get(id);
      if (!binding)
        throw new TextAttachmentError(409, "Backend 已重启，旧插入资格失效");
      this.recheck(binding.target);
      const release = beginTextAttachmentDelivery(
        binding.target.session,
        binding.revision,
      );
      let dispatching = false;
      try {
        await this.files.protect(
          sessionId,
          {
            operationId: request.operationId,
            kind: "insert",
            status: "dispatching",
            attachmentIds: [id],
          },
          fingerprint,
        );
        this.recheck(binding.target, false);
        dispatching = true;
        await pasteTextAttachmentReference(
          this.tmux,
          binding.target.pane,
          attachment.tuiReference,
          () => this.recheck(binding.target, false),
        );
        await this.files.finish(sessionId, request.operationId, "accepted");
      } catch (error) {
        await this.files
          .finish(
            sessionId,
            request.operationId,
            dispatching ? "unknown" : "rejected",
            error instanceof TextAttachmentError
              ? error.message
              : "路径交付未确认，请核对终端",
          )
          .catch(() => undefined);
        if (!dispatching) throw error;
      } finally {
        await release();
      }
      return this.files.operation(sessionId, request.operationId);
    });
  }
  private async previous(
    sessionId: string,
    operationId: string,
    fingerprint: string,
  ) {
    try {
      const previous = await this.files.operation(sessionId, operationId);
      if (previous.fingerprint !== fingerprint)
        throw new TextAttachmentError(409, "operationId 已用于其他请求");
      return previous;
    } catch (error) {
      if (error instanceof TextAttachmentError && error.status === 404)
        return null;
      throw error;
    }
  }
  composer(
    sessionId: string,
    request: SendTerminalInputRequest,
  ): Promise<SendTerminalInputResponse> {
    if (
      !request.operationId ||
      !request.panelId ||
      request.mode !== "prompt_replace" ||
      !request.submit ||
      !request.textAttachmentIds?.length
    )
      throw new TextAttachmentError(
        400,
        "附件提交需要操作 ID、明确的 panel 及浮动输入器提交模式",
      );
    const operationId = request.operationId;
    const ids = request.textAttachmentIds;
    return this.once(sessionId, operationId, request, async () => {
      const fingerprint = attachmentFingerprint(request);
      const previous = await this.previous(sessionId, operationId, fingerprint);
      if (previous) {
        if (previous.status !== "accepted")
          throw new TextAttachmentError(
            409,
            "附件提交结果未确认，请查询原操作",
          );
        return {
          operationId,
          terminalSessionId: sessionId,
          inputAccepted: true,
          inputEnqueued: true,
          runtimeKind: "tmux",
          acceptedAt: new Date().toISOString(),
        };
      }
      const target = this.target(
        sessionId,
        request.panelId!,
      );
      const revision = terminalInputAdmission(target.session).revision;
      const references: string[] = [];
      for (const id of ids) {
        const file = await this.files.get(sessionId, id);
        await this.files.read(sessionId, id);
        if (
          file.panelId !== target.panel.id ||
          file.purpose !== "composer"
        )
          throw new TextAttachmentError(409, "附件不属于当前草稿");
        references.push(JSON.stringify(file.filePath));
      }
      this.recheck(target);
      const release = beginTextAttachmentDelivery(target.session, revision);
      try {
        await this.files.protect(
          sessionId,
          {
            operationId,
            kind: "composer",
            status: "dispatching",
            attachmentIds: ids,
          },
          fingerprint,
        );
        this.recheck(target, false);
        // Dispatch owns the admission lease; release its returning flag only through a private option.
        const response = await sendInputToSession(
          this.manager,
          {
            runtimeRegistry: this.registry,
            ptyService: this.pty,
            tmuxService: this.tmux,
            textAttachmentLease: true,
            beforeTextAttachmentWrite: () =>
              this.recheck(target, false),
          },
          target.session,
          `${request.data}\n\n文本附件，请读取文件内容：\n${references.join("\n")}`,
          "prompt_replace",
          operationId,
          target.pane,
          true,
          request.submitKey,
        );
        await this.files.finish(sessionId, operationId, "accepted");
        return response;
      } catch (error) {
        await this.files
          .finish(
            sessionId,
            operationId,
            "unknown",
            "附件提交结果未确认，请核对终端",
          )
          .catch(() => undefined);
        throw error;
      } finally {
        await release();
      }
    });
  }
}
