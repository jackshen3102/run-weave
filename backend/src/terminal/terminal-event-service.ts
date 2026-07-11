import { randomUUID } from "node:crypto";
import type {
  TerminalEventCursorGap,
  TerminalEventEnvelope,
} from "@runweave/shared/terminal/events";
import { logger } from "../logging";

const MAX_TERMINAL_EVENTS = 500;

export type RecordTerminalEventInput = TerminalEventEnvelope extends infer Event
  ? Event extends TerminalEventEnvelope
    ? Omit<Event, "id" | "createdAt">
    : never
  : never;

export type TerminalEventListener = (event: TerminalEventEnvelope) => void;

const terminalEventServiceLogger = logger.child({
  component: "terminal-event-service",
});

export class TerminalEventService {
  private events: TerminalEventEnvelope[] = [];
  private nextId = 1;
  private readonly streamId = randomUUID();
  private readonly listeners = new Set<TerminalEventListener>();

  record(input: RecordTerminalEventInput): TerminalEventEnvelope {
    const event: TerminalEventEnvelope = {
      ...input,
      id: String(this.nextId),
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.events = [...this.events, event].slice(-MAX_TERMINAL_EVENTS);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        terminalEventServiceLogger.error("terminal-event.listener.failed", {
          message: "Terminal event listener failed",
          eventId: event.id,
          terminalSessionId: event.terminalSessionId,
          kind: event.kind,
          error,
        });
      }
    }

    return event;
  }

  listAfter(afterId: string | null): TerminalEventEnvelope[] {
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

  getStreamId(): string {
    return this.streamId;
  }

  getCursorGap(afterId: string | null): TerminalEventCursorGap | null {
    if (!afterId) {
      return null;
    }

    const after = Number(afterId);
    if (!Number.isInteger(after) || after < 0) {
      return null;
    }

    const oldestAvailableEventId = this.events[0]?.id ?? null;
    const latestEventId = this.getLatestId();
    if (latestEventId === null) {
      return after === 0
        ? null
        : {
            reason: "cursor-ahead",
            requestedAfter: afterId,
            oldestAvailableEventId,
            latestEventId,
          };
    }

    if (after > Number(latestEventId)) {
      return {
        reason: "cursor-ahead",
        requestedAfter: afterId,
        oldestAvailableEventId,
        latestEventId,
      };
    }

    if (
      oldestAvailableEventId !== null &&
      after < Number(oldestAvailableEventId) - 1
    ) {
      return {
        reason: "cursor-too-old",
        requestedAfter: afterId,
        oldestAvailableEventId,
        latestEventId,
      };
    }

    return null;
  }

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
