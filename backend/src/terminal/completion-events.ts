import type { TerminalCompletionEvent } from "@browser-viewer/shared";
import type { TerminalSessionRecord } from "./manager";

const MAX_COMPLETION_EVENTS = 200;

export interface RecordTerminalCompletionEventInput {
  terminalSessionId: string;
  source: TerminalCompletionEvent["source"];
  hookEvent: string;
  cwd: string | null;
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
      hookEvent: input.hookEvent,
      cwd: input.cwd,
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
}
