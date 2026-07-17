import type { TerminalCompletionEvent, TerminalCompletionReason } from "@runweave/shared/terminal/completion";
import type { TerminalSessionRecord } from "./manager";

const MAX_COMPLETION_EVENTS = 200;

export interface RecordTerminalCompletionEventInput {
  terminalSessionId: string;
  source: TerminalCompletionEvent["source"];
  completionReason: TerminalCompletionReason;
  commandName: string | null;
  rawHookEvent: string | null;
  cwd: string | null;
  outboxPath?: string | null;
  summary?: string | null;
  operationId?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
}

export class TerminalCompletionEventStore {
  private events: TerminalCompletionEvent[] = [];
  private nextId = 1;

  record(
    input: RecordTerminalCompletionEventInput,
    session: TerminalSessionRecord,
  ): TerminalCompletionEvent {
    const event: TerminalCompletionEvent = {
      id: String(this.nextId),
      terminalSessionId: input.terminalSessionId,
      projectId: session.projectId,
      source: input.source,
      completionReason: input.completionReason,
      commandName: input.commandName,
      rawHookEvent: input.rawHookEvent,
      hookEvent: input.rawHookEvent ?? input.completionReason,
      cwd: input.cwd,
      outboxPath: input.outboxPath ?? null,
      summary: input.summary ?? null,
      operationId: input.operationId ?? null,
      panelId: input.panelId ?? null,
      tmuxPaneId: input.tmuxPaneId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.events = [...this.events, event].slice(-MAX_COMPLETION_EVENTS);
    return event;
  }

  listAfter(afterId: string | null): TerminalCompletionEvent[] {
    if (!afterId) {
      return [...this.events];
    }

    const after = Number(afterId);
    if (!Number.isFinite(after)) {
      return [...this.events];
    }

    return this.events.filter((event) => Number(event.id) > after);
  }

  getLatestId(): string | null {
    return this.events[this.events.length - 1]?.id ?? null;
  }
}
