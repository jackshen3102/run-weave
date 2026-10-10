import type {
  SendTerminalInputRequest,
  TerminalInputMode,
} from "@runweave/shared/terminal/input";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import type { TerminalEventService } from "../state/terminal-event-service";
import type { TerminalQuickInputService } from "../quick-input/service";
import { sendInputToSession } from "./input-dispatcher";
import { isTmuxBackedSession } from "../runtime/launcher";
import { resolvePanelTarget } from "./panel-targets";
import { getTerminalSessionAgent } from "../state/terminal-state-service";
import { logger } from "../../logging/index";
const terminalLogger = logger.child({ component: "terminal" });
export class TerminalInputSubmissionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type TerminalSubmissionOptions = NonNullable<
  Parameters<typeof sendInputToSession>[1]
> & {
  terminalEventService?: TerminalEventService;
  quickInputService?: TerminalQuickInputService;
};
export async function submitTerminalInput(
  terminalSessionManager: TerminalSessionManager,
  options: TerminalSubmissionOptions,
  session: TerminalSessionRecord,
  input: SendTerminalInputRequest,
  beforeDispatch?: () => void,
) {
  const inputMode = input.mode as TerminalInputMode | undefined;
  const panelTarget =
    isTmuxBackedSession(session) && options.tmuxService
      ? await resolvePanelTarget(
          terminalSessionManager,
          session,
          {
            tmuxService: options.tmuxService,
            terminalEventService: options.terminalEventService,
          },
          {
            panelId: input.panelId,
            panelAlias: input.panelAlias,
            role: input.role,
          },
          "explicit-or-active",
        )
      : undefined;
  if (
    input.quickInputSource === "web_browser_annotation" &&
    !getTerminalSessionAgent(panelTarget?.panel ?? session)
  ) {
    throw new TerminalInputSubmissionError(
      409,
      "Browser comments require an active Agent terminal",
    );
  }
  beforeDispatch?.();
  const payload = await sendInputToSession(
    terminalSessionManager,
    options,
    session,
    input.data,
    inputMode,
    input.operationId,
    panelTarget?.paneTarget,
    input.submit,
    input.submitKey,
    input.expectedThreadId,
  );
  if (
    options.quickInputService &&
    payload.inputAccepted &&
    input.recordQuickInput !== false
  ) {
    try {
      await options.quickInputService.recordRecentInput({
        data: input.data,
        mode: inputMode,
        projectId: session.projectId,
        terminalSessionId: session.id,
        cwd: session.cwd,
        source: input.quickInputSource ?? "api_terminal_input",
        acceptedAt: payload.acceptedAt,
      });
    } catch (error) {
      terminalLogger.warn("terminal.quick-input.record.failed", {
        message: "Terminal quick input record failed",
        terminalSessionId: session.id,
        projectId: session.projectId,
        inputMode: inputMode ?? "raw",
        error,
      });
    }
  }
  return payload;
}
