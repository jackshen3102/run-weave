import type { Express, RequestHandler } from "express";
import type { RuntimeServices } from "../../bootstrap/runtime-services-contract";
import { createInternalTerminalCompletionRouter } from "../terminal/completion";
import { createHookDiagnosticsRouter } from "../terminal/hook-diagnostics";
import { createInternalTerminalAgentHookRouter } from "../terminal/state";

type InternalTerminalServices = Pick<
  RuntimeServices,
  | "feishuConnector"
  | "hookDiagnostics"
  | "terminalActivity"
  | "terminalCompletionEventService"
  | "terminalQuestionsService"
  | "terminalSessionManager"
  | "terminalStateService"
  | "tmuxService"
>;

export function registerInternalTerminalRoutes(
  app: Express,
  services: InternalTerminalServices,
  requireTunnelAuth: RequestHandler,
  hookToken: string | undefined,
): void {
  app.use(
    "/internal/terminal/hook-diagnostics",
    requireTunnelAuth,
    createHookDiagnosticsRouter({
      hookToken,
      terminalSessionManager: services.terminalSessionManager,
      tmuxService: services.tmuxService,
      diagnostics: services.hookDiagnostics,
    }),
  );
  app.use(
    "/internal/terminal/agent-hook",
    requireTunnelAuth,
    createInternalTerminalAgentHookRouter({
      terminalSessionManager: services.terminalSessionManager,
      terminalStateService: services.terminalStateService,
      hookToken,
      activity: services.terminalActivity,
      questionNotifications: services.terminalQuestionsService.notifications,
      terminalQuestionsService: services.terminalQuestionsService,
      hookDiagnostics: services.hookDiagnostics,
    }),
  );
  app.use(
    "/internal/terminal-completion",
    requireTunnelAuth,
    createInternalTerminalCompletionRouter({
      feishuConnector: services.feishuConnector,
      completionEventService: services.terminalCompletionEventService,
      terminalSessionManager: services.terminalSessionManager,
      hookToken,
      tmuxService: services.tmuxService,
    }),
  );
}
