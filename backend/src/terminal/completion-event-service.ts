import type { TerminalCompletionEvent } from "@browser-viewer/shared";
import { logger } from "../logging";
import type {
  RecordTerminalCompletionEventInput,
  TerminalCompletionEventStore,
} from "./completion-events";
import type { TerminalSessionRecord } from "./manager";

export type TerminalCompletionEventListener = (
  event: TerminalCompletionEvent,
) => void;

const completionEventServiceLogger = logger.child({
  component: "terminal-completion-event-service",
});

export class TerminalCompletionEventService {
  private readonly listeners = new Set<TerminalCompletionEventListener>();

  constructor(private readonly store: TerminalCompletionEventStore) {}

  record(
    input: RecordTerminalCompletionEventInput,
    session: TerminalSessionRecord,
  ): TerminalCompletionEvent {
    const event = this.store.record(input, session);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        completionEventServiceLogger.error("terminal-completion.listener.failed", {
          message: "Terminal completion event listener failed",
          eventId: event.id,
          terminalSessionId: event.terminalSessionId,
          error,
        });
      }
    }
    return event;
  }

  listAfter(afterId: string | null): TerminalCompletionEvent[] {
    return this.store.listAfter(afterId);
  }

  getLatestId(): string | null {
    return this.store.getLatestId();
  }

  subscribe(listener: TerminalCompletionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
