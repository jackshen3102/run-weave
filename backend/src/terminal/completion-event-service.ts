import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { RecordTerminalCompletionEventInput } from "./completion-events";
import type { TerminalEventService } from "./terminal-event-service";
import type { TerminalSessionRecord } from "./manager";

export class TerminalCompletionEventService {
  constructor(private readonly terminalEventService: TerminalEventService) {}

  record(
    input: RecordTerminalCompletionEventInput,
    session: TerminalSessionRecord,
  ): TerminalEventEnvelope {
    return this.terminalEventService.record({
      kind: "completion",
      terminalSessionId: input.terminalSessionId,
      projectId: session.projectId,
      payload: {
        source: input.source,
        completionReason: input.completionReason,
        commandName: input.commandName,
        rawHookEvent: input.rawHookEvent,
        hookEvent: input.rawHookEvent ?? input.completionReason,
        cwd: input.cwd,
        outboxPath: input.outboxPath ?? null,
        summary: input.summary ?? null,
        panelId: input.panelId ?? null,
        tmuxPaneId: input.tmuxPaneId ?? null,
      },
    });
  }

  listAfter(afterId: string | null): TerminalEventEnvelope[] {
    return this.terminalEventService
      .listAfter(afterId)
      .filter((event) => event.kind === "completion");
  }
}
