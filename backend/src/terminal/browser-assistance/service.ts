import {
  scheduledBrowserGroupId,
  scheduledRunRecovery,
  type ScheduledRun,
} from "@runweave/shared/scheduled-tasks";
import { randomUUID } from "node:crypto";
import type {
  BrowserAssistanceRequest,
  CreateBrowserAssistanceRequest,
} from "@runweave/shared/terminal-browser-assistance";
import type { TerminalSessionManager } from "../manager/manager";
import type { TmuxService } from "../tmux/service";
import { resolveEffectivePanelActiveCommand } from "../application/panel-metadata";
import { resolveTmuxTarget } from "../runtime/launcher";
import {
  beginTerminalReturn,
  terminalInputAdmission,
  TerminalInputBusyError,
} from "../runtime/input-admission";

const TTL_MS = 30 * 60_000;
const ACTIVE = new Set([
  "requesting",
  "waiting",
  "resume_pending",
  "delivery_unknown",
]);

interface Entry {
  request: BrowserAssistanceRequest;
  paneId: string;
  panelCreatedAt: number;
  inputRevision: object;
  agentOperationId: string | null;
}

export class BrowserAssistanceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cooperative handoff, not a browser lease or an Agent interrupt mechanism. */
export class BrowserAssistanceService {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly manager: TerminalSessionManager,
    private readonly tmux?: TmuxService,
  ) {}

  private panel(sessionId: string, panelId: string) {
    const session = this.manager.getSession(sessionId);
    const panel = this.manager.getPanel(panelId);
    if (
      !session ||
      session.status !== "running" ||
      !panel ||
      panel.terminalSessionId !== sessionId ||
      panel.status !== "running" ||
      !panel.tmuxPaneId
    ) {
      throw new BrowserAssistanceError(
        409,
        "Original Terminal panel is unavailable",
      );
    }
    const provider = panel.threadId
      ? panel.threadProvider
      : panel.lastThreadProvider;
    const threadId = panel.threadId || panel.lastThreadId;
    if (
      !threadId ||
      provider !== "codex" ||
      panel.terminalState?.agent !== "codex" ||
      !["agent_running", "agent_idle"].includes(panel.terminalState.state) ||
      !panel.activeCommand?.includes("codex")
    ) {
      throw new BrowserAssistanceError(
        409,
        "An existing Codex conversation is required",
      );
    }
    return { session, panel, threadId };
  }

  private refresh(entry: Entry): BrowserAssistanceRequest {
    const request = entry.request;
    if (!ACTIVE.has(request.state)) return request;
    if (Date.now() >= Date.parse(request.expiresAt)) {
      request.state = "expired";
      return request;
    }
    try {
      const { session, panel, threadId } = this.panel(
        request.terminalSessionId,
        request.panelId,
      );
      if (
        terminalInputAdmission(session).inputWriteRevision !==
          entry.inputRevision ||
        (this.manager.getPanelAgentOperationGeneration(session.id, panel.id)
          ?.operationId ?? null) !== entry.agentOperationId ||
        threadId !== request.threadId ||
        panel.tmuxPaneId !== entry.paneId ||
        panel.createdAt.getTime() !== entry.panelCreatedAt
      ) {
        request.state = "invalidated";
      } else if (
        request.state === "requesting" &&
        panel.terminalState?.state === "agent_idle"
      ) {
        request.state = "waiting";
      }
    } catch {
      request.state = "invalidated";
    }
    return request;
  }

  list(sessionId: string): BrowserAssistanceRequest[] {
    // Runtime-scoped tombstones prevent duplicate delivery without growing forever.
    for (const [id, entry] of this.entries) {
      this.refresh(entry);
      if (Date.now() > Date.parse(entry.request.expiresAt) + TTL_MS)
        this.entries.delete(id);
    }
    return [...this.entries.values()]
      .filter((entry) => entry.request.terminalSessionId === sessionId)
      .map((entry) => ({ ...entry.request }));
  }

  /** Explicit user takeover imports the persisted request once per result. */
  fromScheduledRun(
    sessionId: string,
    run: ScheduledRun,
  ): BrowserAssistanceRequest | null {
    const recovery = scheduledRunRecovery(run);
    if (recovery?.action !== "needs-input" || !recovery.browser) return null;
    const binding = run.terminalBinding;
    const session = this.manager.getSession(sessionId);
    if (
      !binding ||
      binding.terminalSessionId !== sessionId ||
      binding.attachmentState !== "ready" ||
      session?.source?.runId !== run.id ||
      run.activeAttemptId ||
      !run.threadRef ||
      recovery.browser.browserGroupId !== scheduledBrowserGroupId(run.id)
    )
      throw new BrowserAssistanceError(
        409,
        "Scheduled browser assistance is not bound to this recovered conversation",
      );
    const { threadId } = this.panel(sessionId, binding.panelId);
    if (threadId !== run.threadRef.threadId)
      throw new BrowserAssistanceError(409, "Scheduled conversation changed");
    const requestId = `scheduled-${run.id}-${run.resultRevision ?? 0}-${sessionId}-${binding.panelId}`;
    if (this.entries.has(requestId)) return this.get(sessionId, requestId);
    return this.create(
      sessionId,
      {
        ...recovery.browser,
        panelId: binding.panelId,
        reason:
          `${run.error?.message ?? run.summary ?? "需要浏览器协助"}\n${recovery.nextStep}`.slice(
            0,
            2000,
          ),
      },
      requestId,
    );
  }

  create(
    sessionId: string,
    input: CreateBrowserAssistanceRequest,
    requestId: string = randomUUID(),
  ): BrowserAssistanceRequest {
    const { session, panel, threadId } = this.panel(sessionId, input.panelId);
    const admission = terminalInputAdmission(session);
    if (admission.writers || admission.returning)
      throw new BrowserAssistanceError(
        409,
        "Terminal input is still in flight",
      );
    if (!this.tmux)
      throw new BrowserAssistanceError(503, "tmux is unavailable");
    const existing = this.list(sessionId).find(
      (request) =>
        request.panelId === input.panelId && ACTIVE.has(request.state),
    );
    if (existing)
      throw new BrowserAssistanceError(
        409,
        `Active assistance request: ${existing.requestId}`,
      );
    const request: BrowserAssistanceRequest = {
      ...input,
      terminalSessionId: sessionId,
      requestId,
      threadId,
      state: "requesting",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      resumedAt: null,
    };
    this.entries.set(request.requestId, {
      request,
      paneId: panel.tmuxPaneId!,
      panelCreatedAt: panel.createdAt.getTime(),
      inputRevision: admission.inputWriteRevision,
      agentOperationId:
        this.manager.getPanelAgentOperationGeneration(sessionId, input.panelId)
          ?.operationId ?? null,
    });
    return { ...request };
  }

  get(sessionId: string, requestId: string): BrowserAssistanceRequest {
    const entry = this.entries.get(requestId);
    if (!entry || entry.request.terminalSessionId !== sessionId) {
      throw new BrowserAssistanceError(
        404,
        "Assistance request expired or unavailable in this Backend runtime",
      );
    }
    return { ...this.refresh(entry) };
  }

  cancel(sessionId: string, requestId: string): BrowserAssistanceRequest {
    const request = this.get(sessionId, requestId);
    if (request.state === "cancelled") return request;
    if (!["requesting", "waiting"].includes(request.state)) {
      throw new BrowserAssistanceError(
        409,
        "Cannot cancel after delivery; use Terminal controls to stop the Agent",
      );
    }
    this.entries.get(requestId)!.request.state = "cancelled";
    return this.get(sessionId, requestId);
  }

  acknowledge(
    sessionId: string,
    requestId: string,
    panelId: string,
  ): BrowserAssistanceRequest {
    const request = this.get(sessionId, requestId);
    if (
      panelId !== request.panelId ||
      !["resume_pending", "delivery_unknown", "acknowledged"].includes(
        request.state,
      )
    ) {
      throw new BrowserAssistanceError(
        409,
        "Request is not awaiting this panel's acknowledgement",
      );
    }
    const { threadId } = this.panel(sessionId, panelId);
    if (threadId !== request.threadId)
      throw new BrowserAssistanceError(409, "Conversation changed");
    this.entries.get(requestId)!.request.state = "acknowledged";
    return this.get(sessionId, requestId);
  }

  async resume(
    sessionId: string,
    requestId: string,
  ): Promise<BrowserAssistanceRequest> {
    const request = this.get(sessionId, requestId);
    if (
      ["resume_pending", "acknowledged", "delivery_unknown"].includes(
        request.state,
      )
    )
      return request;
    if (request.state !== "waiting")
      throw new BrowserAssistanceError(
        409,
        "Request is not waiting for the user",
      );
    const { session, panel } = this.panel(sessionId, request.panelId);
    if (panel.terminalState?.state !== "agent_idle") {
      throw new BrowserAssistanceError(
        409,
        "Agent is busy; finish its current turn before returning control",
      );
    }
    const entry = this.entries.get(requestId)!;
    let release: () => void;
    try {
      release = beginTerminalReturn(session);
    } catch (error) {
      if (error instanceof TerminalInputBusyError)
        throw new BrowserAssistanceError(409, error.message);
      throw error;
    }
    // Claim synchronously before any I/O: concurrent returns cannot send twice.
    entry.request.state = "resume_pending";
    entry.request.resumedAt = new Date().toISOString();
    try {
      if (!this.tmux) throw new Error("tmux unavailable");
      const target = resolveTmuxTarget(session, this.tmux);
      const panes = await this.tmux.listPanes(target);
      if (
        !panes.some(
          (pane) =>
            pane.paneId === entry.paneId &&
            resolveEffectivePanelActiveCommand(pane, panel.activeCommand) ===
              "codex",
        )
      ) {
        entry.request.state = "invalidated";
        throw new BrowserAssistanceError(
          409,
          "Original Codex pane is unavailable",
        );
      }
      const current = this.get(sessionId, requestId);
      if (
        current.state !== "resume_pending" ||
        this.panel(sessionId, request.panelId).panel.terminalState?.state !==
          "agent_idle"
      ) {
        entry.request.state = "invalidated";
        throw new BrowserAssistanceError(
          409,
          "Agent changed while returning control",
        );
      }
      // Never ensure/recreate a runtime, prepare a new Agent, or replay user text.
      const prompt = `Browser assistance ${requestId} has been returned by the user. First run: "\${RUNWEAVE_CLI_BIN:-rw}" browser assist acknowledge ${requestId} --json . If acknowledgement fails, stop. Read the returned target binding, attach to that exact Profile/Group/target and take a fresh snapshot. Do not replay previous clicks. If the task is already complete, do not submit again. If still blocked, detach, request assistance again and end your turn. Otherwise continue the original task, then detach.`;
      await this.tmux.sendKeySequence({ ...target, paneId: entry.paneId }, [
        { type: "literal", value: prompt, delayAfterMs: 200 },
        { type: "key", key: "C-m" },
      ]);
    } catch (error) {
      if (entry.request.state === "resume_pending")
        entry.request.state = "delivery_unknown";
      if (error instanceof BrowserAssistanceError) throw error;
      // Delivery may have partially succeeded. Do not expose a retryable failure.
    } finally {
      release();
    }
    return this.get(sessionId, requestId);
  }
}
