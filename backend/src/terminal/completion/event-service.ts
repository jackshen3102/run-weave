import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { RecordTerminalCompletionEventInput } from "./events";
import type { TerminalEventService } from "../state/terminal-event-service";
import { formatReplyPreview, resolveReplyThread } from "./reply-preview";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";

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

    const owner = input.panelId
      ? this.terminalSessionManager.getPanel(input.panelId)
      : session;
    const identity = owner ? resolveReplyThread(owner) : null;
    const text = formatReplyPreview(input.summary);
    if (
      identity &&
      input.completionReason === "hook_stop" &&
      input.rawHookEvent?.toLowerCase() === "stop" &&
      (!input.threadId || input.threadId === identity.id) &&
      input.source === identity.provider
    ) {
      await this.terminalSessionManager.updateLatestReply(
        session.id,
        input.panelId ?? null,
        {
          threadId: identity.id,
          provider: identity.provider,
          text:
            text ??
            (owner?.latestReply?.threadId === identity.id &&
            owner.latestReply.provider === identity.provider
              ? owner.latestReply.text
              : null),
          completionRevision,
          needsRefresh: !text,
        },
      );
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
        threadId: input.threadId ?? null,
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
