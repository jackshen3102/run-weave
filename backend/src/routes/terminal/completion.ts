import { codexHookBelongsToPrimary } from "../../terminal/runtime/codex-context";
import { feishuNotifyHandler } from "../feishu";
import type { FeishuBridgeConnector } from "../../feishu/bridge-connector";
import { isPiAgentContext } from "@runweave/shared/terminal/pi-agent";
import { Router } from "express";
import { z } from "zod";
import type { TerminalCompletionEvent } from "@runweave/shared/terminal/completion";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import { logger } from "../../logging/index";
import type { TerminalCompletionEventService } from "../../terminal/completion/event-service";
import {
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
  getCompletionSourceForCommand,
  isCompletionSourceAllowedForCommand,
} from "../../terminal/completion/source-gate";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { getTerminalSessionAgent } from "../../terminal/state/terminal-state-service";
import { isTmuxBackedSession, resolveTmuxTarget } from "../../terminal/runtime/launcher";
import type { TmuxService } from "../../terminal/tmux/service";

const completionReasonEnum = z.enum([
  "hook_stop",
  "notify",
  "ai_process_exit",
  "manual",
]);
const terminalCompletionLogger = logger.child({
  component: "terminal-completion",
});

const completionEventSchema = z
  .object({
    claude: z.object({
      instanceId: z.string().min(1).max(256), eventId: z.string().uuid(),
      notificationType: z.string().max(128).optional(), query: z.string().max(8_000).optional(),
    }).strict().optional(),
    pi: z.custom<import("@runweave/shared/terminal/pi-agent").PiAgentContext>(isPiAgentContext).optional(),
    feishuNotificationOnly: z.boolean().optional(),
    terminalSessionId: z.string().trim().min(1),
    source: z
      .enum(["claude", "codex", "trae", "traecli", "traex", "pi", "unknown"])
      .default("unknown"),
    completionReason: completionReasonEnum.optional(),
    commandName: z.string().trim().min(1).nullable().optional(),
    rawHookEvent: z.string().trim().min(1).nullable().optional(),
    // deprecated: accepted for backward compat, mapped to rawHookEvent
    hookEvent: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
    summary: z.string().trim().min(1).nullable().optional(),
    threadId: z.string().trim().min(1).nullable().optional(),
    operationId: z.string().trim().min(1).max(256).nullable().optional(),
    panelId: z.string().trim().min(1).nullable().optional(),
    tmuxPaneId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export function createInternalTerminalCompletionRouter(options: {
  completionEventService: TerminalCompletionEventService;
  terminalSessionManager: TerminalSessionManager;
  hookToken: string | undefined;
  tmuxService?: TmuxService;
  feishuConnector?: FeishuBridgeConnector;
}): Router {
  const router = Router();
  const piCompletions = new Set<string>();
  router.post("/feishu/notify", (req, res, next) => {
    if (!options.hookToken || req.header("x-runweave-hook-token") !== options.hookToken) { res.status(401).json({ message: "Unauthorized" }); return; }
    next();
  }, feishuNotifyHandler(options.feishuConnector, options.terminalSessionManager));

  router.post("/feishu", async (req, res) => {
    if (!options.hookToken || req.header("x-runweave-hook-token") !== options.hookToken) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const parsed = z.object({
      terminalSessionId: z.string().min(1),
      notificationId: z.union([z.string().uuid(), z.string().regex(/^[1-9]\d{0,15}$/)]),
      claim: z.boolean(),
    }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid notification request" }); return; }
    try {
      res.json(await options.terminalSessionManager.feishuNotifications.decide(
        parsed.data.terminalSessionId, parsed.data.notificationId, parsed.data.claim,
      ));
    } catch (error) {
      terminalCompletionLogger.warn("terminal-completion.feishu-policy.failed", { error });
      res.status(503).json({ message: "Notification policy unavailable" });
    }
  });

  router.post("/", async (req, res) => {
    const expectedToken = options.hookToken;
    if (!expectedToken) {
      terminalCompletionLogger.warn("terminal-completion.hook.unavailable", {
        message: "Terminal completion hook unavailable; no token configured",
      });
      res.status(503).json({ message: "Terminal completion hook unavailable" });
      return;
    }

    if (req.header("x-runweave-hook-token") !== expectedToken) {
      terminalCompletionLogger.warn("terminal-completion.hook.unauthorized", {
        message: "Terminal completion hook token rejected",
      });
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = completionEventSchema.safeParse(req.body);
    if (!parsed.success) {
      terminalCompletionLogger.warn("terminal-completion.body.invalid", {
        message: "Terminal completion request body invalid",
        errors: parsed.error.flatten(),
      });
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = options.terminalSessionManager.getSession(
      parsed.data.terminalSessionId,
    );
    if (!session) {
      terminalCompletionLogger.warn("terminal-completion.session.missing", {
        message: "Terminal completion session not found",
        terminalSessionId: parsed.data.terminalSessionId,
      });
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    // Legacy Claude hooks have no native process identity or settled proof.
    if (parsed.data.source === "claude" && !parsed.data.claude) {
      res.status(202).json({ event: null, ignored: true, reason: "claude_lifecycle_unverified" });
      return;
    }

    const rawHookEvent =
      parsed.data.rawHookEvent ?? parsed.data.hookEvent ?? null;
    const resolvedPane = resolveCompletionPane(
      options.terminalSessionManager,
      session.id,
      parsed.data.panelId ?? null,
      parsed.data.tmuxPaneId ?? null,
    );
    if (!resolvedPane.ok) {
      terminalCompletionLogger.warn("terminal-completion.pane.invalid", {
        message: "Terminal completion pane identity rejected",
        terminalSessionId: parsed.data.terminalSessionId,
        panelId: parsed.data.panelId ?? null,
        tmuxPaneId: parsed.data.tmuxPaneId ?? null,
        reason: resolvedPane.reason,
      });
      res.status(202).json({
        event: null,
        ignored: true,
        reason: resolvedPane.reason,
      });
      return;
    }
    const { panelId, tmuxPaneId } = resolvedPane;
    const targetPanel = panelId
      ? (options.terminalSessionManager.getPanel(panelId) ?? null)
      : null;
    if (parsed.data.source === "codex" && targetPanel &&
        !(await codexHookBelongsToPrimary(targetPanel, parsed.data.threadId))) {
      res.status(202).json({ event: null, ignored: true, reason: "codex_context_mismatch" });
      return;
    }
    let paneActiveCommand = targetPanel?.activeCommand ?? null;
    if (parsed.data.source === "claude" && parsed.data.claude && targetPanel?.tmuxPaneId &&
        options.tmuxService && isTmuxBackedSession(session)) {
      // Manual Claude launches may leave the Panel projection behind the live
      // pane. Read this exact pane; the session's selected pane may be another CLI.
      try {
        const metadata = await options.tmuxService.readPaneMetadata({
          ...resolveTmuxTarget(session, options.tmuxService), paneId: targetPanel.tmuxPaneId,
        }, session.command);
        paneActiveCommand = metadata?.activeCommand ?? null;
      } catch (error) {
        terminalCompletionLogger.warn("terminal-completion.pane-read.failed", { terminalSessionId: session.id, panelId, error });
        res.status(503).json({ message: "Terminal pane identity unavailable" }); return;
      }
    }
    const targetActiveCommand = panelId
      ? paneActiveCommand
      : session.activeCommand;
    const effectiveSource = resolveEffectiveCompletionSource({
      reportedSource: parsed.data.source,
      paneActiveCommand,
      sessionActiveCommand: session.activeCommand,
      commandName: parsed.data.commandName ?? null,
    });
    if ((effectiveSource === "claude" && !parsed.data.claude) ||
        (parsed.data.source === "claude" && effectiveSource !== "claude")) {
      res.status(202).json({ event: null, ignored: true, reason: "claude_lifecycle_unverified" });
      return;
    }
    const recentAgentActivity =
      options.terminalSessionManager.getRecentAgentActivity(
        session.id,
        panelId,
      );
    const operationGeneration = panelId
      ? options.terminalSessionManager.getPanelAgentOperationGeneration(
          session.id,
          panelId,
        )
      : null;
    const operationIdentityMatches = operationGeneration
      ? parsed.data.operationId === operationGeneration.operationId &&
        isCompletionSourceAllowedForCommand(
          effectiveSource,
          operationGeneration.provider,
        )
      : true;
    if (!operationIdentityMatches) {
      terminalCompletionLogger.info("terminal-completion.ignored", {
        message: "Terminal completion operation identity rejected",
        terminalSessionId: parsed.data.terminalSessionId,
        panelId,
        operationId: parsed.data.operationId ?? null,
        reason: "operation_identity_mismatch",
      });
      res.status(202).json({
        event: null,
        ignored: true,
        reason: "operation_identity_mismatch",
      });
      return;
    }
    const targetCommandSource = getCompletionSourceForCommand(
      targetActiveCommand,
    );
    const reportedCommandMatchesCurrentTarget =
      targetCommandSource === effectiveSource &&
      targetCommandSource ===
        getCompletionSourceForCommand(parsed.data.commandName ?? null);
    const currentCommandMatches =
      isCompletionSourceAllowedForCommand(
        effectiveSource,
        targetActiveCommand,
      ) ||
      reportedCommandMatchesCurrentTarget ||
      getTerminalSessionAgent(targetPanel ?? session) === effectiveSource;
    const now = Date.now();
    const graceCommandMatches =
      targetActiveCommand === null &&
      recentAgentActivity?.phase === "grace" &&
      recentAgentActivity.source === effectiveSource &&
      recentAgentActivity.clearedAt !== null &&
      (recentAgentActivity.operationId === null
        ? operationGeneration === null
        : recentAgentActivity.operationId === parsed.data.operationId) &&
      now - recentAgentActivity.clearedAt <=
        AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;

    if (!currentCommandMatches && !graceCommandMatches) {
      terminalCompletionLogger.info("terminal-completion.ignored", {
        message: "Terminal completion event ignored",
        terminalSessionId: parsed.data.terminalSessionId,
        source: parsed.data.source,
        effectiveSource,
        activeCommand: session.activeCommand,
        paneActiveCommand,
        recentAgentActivity: recentAgentActivity?.command ?? null,
        recentAgentActivityClearedAt: recentAgentActivity?.clearedAt
          ? new Date(recentAgentActivity.clearedAt).toISOString()
          : null,
        rawHookEvent,
      });
      res.status(202).json({ event: null, ignored: true });
      return;
    }

    let feishuTurnId: string | undefined;
    let summary = parsed.data.summary ?? null;
    let completionReason = parsed.data.completionReason ?? "hook_stop";
    let completionHookEvent = rawHookEvent;
    if (effectiveSource === "claude") {
      if (session.status !== "running" || targetCommandSource !== "claude" ||
          parsed.data.source !== "claude" || !parsed.data.claude) {
        res.status(202).json({ ignored: true }); return;
      }
      const result = await options.terminalSessionManager.feishuNotifications.observeClaudeHook({
        ...parsed.data, source: effectiveSource, completionReason, rawHookEvent, panelId,
        claude: parsed.data.claude,
      });
      if (!result.settled) { res.status(202).json(result); return; }
      feishuTurnId = result.turnId;
      summary = result.summary;
      completionReason = "hook_stop";
      completionHookEvent = "Stop";
    }

    if (parsed.data.feishuNotificationOnly) {
      if (parsed.data.completionReason !== "notify") {
        res.status(400).json({ message: "Notification-only requests require notify reason" }); return;
      }
      const pi = parsed.data.pi;
      const owner = targetPanel ?? session;
      if (effectiveSource === "pi" && (!pi || owner.pi?.instanceId !== pi.instanceId || owner.pi?.sequence !== pi.sequence)) {
        res.status(202).json({ ignored: true }); return;
      }
      try {
        const notificationId = await options.terminalSessionManager.feishuNotifications.attention(session.id, panelId);
        res.status(202).json({ notificationId });
      } catch (error) {
        terminalCompletionLogger.warn("terminal-completion.feishu-attention.failed", { error });
        res.status(503).json({ message: "Notification policy unavailable" });
      }
      return;
    }

    const pi = parsed.data.pi;
    const piKey = pi ? `${pi.instanceId}:${pi.sequence}` : null;
    if (effectiveSource === "pi") {
      const owner = targetPanel ?? session;
      if (!pi || pi.outcome !== "completed" || pi.event !== "agent_settled" ||
          owner.pi?.instanceId !== pi.instanceId || owner.pi.sequence !== pi.sequence ||
          owner.pi.sessionId !== parsed.data.threadId || !piKey || piCompletions.has(piKey) || targetPanel?.piLastCompletionKey === piKey) {
        res.status(202).json({ event: null, ignored: true }); return;
      }
      piCompletions.add(piKey);
      if (piCompletions.size > 500) piCompletions.delete(piCompletions.values().next().value!);
    }
    let event: TerminalEventEnvelope;
    try {
      // Persist the accepted identity before emitting; replay after restart stays silent.
      if (effectiveSource === "pi" && targetPanel && piKey) {
        targetPanel.piLastCompletionKey = piKey;
        await options.terminalSessionManager.upsertPanel(targetPanel);
      }
      event = await options.completionEventService.record(
        {
          terminalSessionId: parsed.data.terminalSessionId,
          source: effectiveSource,
          completionReason,
          commandName: parsed.data.commandName ?? null,
          rawHookEvent: completionHookEvent,
          cwd: parsed.data.cwd ?? null,
          summary,
          threadId: parsed.data.threadId ?? null,
          operationId: parsed.data.operationId ?? null,
          panelId,
          tmuxPaneId,
        },
        session,
        feishuTurnId,
      );
    } catch (error) {
      if (piKey) piCompletions.delete(piKey);
      terminalCompletionLogger.error("terminal-completion.record.failed", {
        message: "Terminal completion event failed to persist",
        terminalSessionId: parsed.data.terminalSessionId,
        error,
      });
      res.status(500).json({ message: "Terminal completion event failed" });
      return;
    }
    terminalCompletionLogger.info("terminal-completion.recorded", {
      message: "Terminal completion event recorded",
      id: event.id,
      terminalSessionId: event.terminalSessionId,
      source: event.kind === "completion" ? event.payload.source : null,
      reportedSource: parsed.data.source,
      activeCommand: session.activeCommand,
      paneActiveCommand,
      recentAgentActivity: recentAgentActivity?.command ?? null,
      recentAgentActivityClearedAt: recentAgentActivity?.clearedAt
        ? new Date(recentAgentActivity.clearedAt).toISOString()
        : null,
      rawHookEvent,
    });
    res.status(202).json({ event });
  });

  return router;
}

function resolveEffectiveCompletionSource(params: {
  reportedSource: TerminalCompletionEvent["source"];
  paneActiveCommand: string | null;
  sessionActiveCommand: string | null;
  commandName: string | null;
}): TerminalCompletionEvent["source"] {
  const inferredSource =
    getCompletionSourceForCommand(params.paneActiveCommand) ??
    getCompletionSourceForCommand(params.commandName) ??
    getCompletionSourceForCommand(params.sessionActiveCommand);

  return inferredSource ?? params.reportedSource;
}

/**
 * Resolve the completing pane. The hook may report a `panelId` (from the pane's
 * `RUNWEAVE_TERMINAL_PANEL_ID` env) or a `tmuxPaneId`; fall back to matching an
 * existing panel record by tmux pane id so pane-as-worker attribution works.
 */
function resolveCompletionPane(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  panelId: string | null,
  tmuxPaneId: string | null,
):
  | { ok: true; panelId: string | null; tmuxPaneId: string | null }
  | {
      ok: false;
      panelId: string | null;
      tmuxPaneId: string | null;
      reason: string;
    } {
  const panels = terminalSessionManager.listPanels(terminalSessionId);
  const byId = panelId
    ? panels.find((panel) => panel.id === panelId) ?? null
    : null;
  const byPane = tmuxPaneId
    ? panels.find((panel) => panel.tmuxPaneId === tmuxPaneId) ?? null
    : null;

  if (panelId) {
    if (!byId) {
      return {
        ok: false,
        panelId,
        tmuxPaneId,
        reason: "unknown_panel_id",
      };
    }
    if (tmuxPaneId && byId.tmuxPaneId !== tmuxPaneId) {
      return {
        ok: false,
        panelId,
        tmuxPaneId,
        reason: "panel_tmux_mismatch",
      };
    }
    return { ok: true, panelId, tmuxPaneId: byId.tmuxPaneId };
  }
  if (tmuxPaneId) {
    return byPane
      ? { ok: true, panelId: byPane.id, tmuxPaneId }
      : {
          ok: false,
          panelId: null,
          tmuxPaneId,
          reason: "unknown_tmux_pane_id",
        };
  }
  const runningPanels = panels.filter((panel) => panel.status === "running");
  if (runningPanels.length === 1) {
    return {
      ok: true,
      panelId: runningPanels[0]!.id,
      tmuxPaneId: runningPanels[0]!.tmuxPaneId,
    };
  }
  return runningPanels.length === 0
    ? { ok: true, panelId: null, tmuxPaneId: null }
    : {
        ok: false,
        panelId: null,
        tmuxPaneId: null,
        reason: "ambiguous_panel_identity",
      };
}
