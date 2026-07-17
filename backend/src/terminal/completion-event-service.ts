import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { RecordTerminalCompletionEventInput } from "./completion-events";
import type { TerminalEventService } from "./terminal-event-service";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "./manager";

export class TerminalCompletionEventService {
  constructor(
    private readonly terminalEventService: TerminalEventService,
    private readonly terminalSessionManager: TerminalSessionManager,
  ) {}

  async record(
    input: RecordTerminalCompletionEventInput,
    session: TerminalSessionRecord,
  ): Promise<TerminalEventEnvelope> {
    const completionRevision =
      await this.terminalSessionManager.recordSessionCompletion(session.id);
    if (completionRevision === null) {
      throw new Error("Terminal session not found while recording completion");
    }

    return this.terminalEventService.record({
      kind: "completion",
      terminalSessionId: input.terminalSessionId,
      projectId: session.projectId,
      payload: {
        source: input.source,
        completionReason: input.completionReason,
        completionRevision,
        commandName: input.commandName,
        rawHookEvent: input.rawHookEvent,
        hookEvent: input.rawHookEvent ?? input.completionReason,
        cwd: input.cwd,
        outboxPath: input.outboxPath ?? null,
        summary: input.summary ?? null,
        operationId: input.operationId ?? null,
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
