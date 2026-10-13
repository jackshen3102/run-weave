import type { ActivityFactDto } from "@runweave/shared/activity";
import type { AppServerThreadDetailResponse } from "@runweave/shared/app-server-events";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";

export type WorkHistorySelection =
  | { type: "terminal"; terminal: TerminalSessionListItem }
  | { type: "thread"; thread: AppServerThreadDetailResponse }
  | { type: "fact"; fact: ActivityFactDto };

export function selectionKey(selection: WorkHistorySelection): string {
  switch (selection.type) {
    case "terminal":
      return `terminal:${selection.terminal.terminalSessionId}`;
    case "thread":
      return `thread:${selection.thread.thread.threadId}`;
    case "fact":
      return `fact:${selection.fact.eventId}`;
  }
}
