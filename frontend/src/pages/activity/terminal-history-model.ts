import type { TerminalArchiveDetail } from "@runweave/shared/work-history";
import type { WorkHistorySelection } from "./work-history-selection";

export interface TerminalJournalEntry {
  id: string;
  occurredAt: string;
  sourceType: "terminal" | "thread" | "turn" | "activity";
  sourceId: string;
  title: string;
  summary: string;
  selection: WorkHistorySelection;
}

export function buildTerminalJournal(
  detail: TerminalArchiveDetail,
): TerminalJournalEntry[] {
  const entries: TerminalJournalEntry[] = [
    {
      id: `terminal:${detail.terminal.terminalSessionId}:created`,
      occurredAt: detail.terminal.createdAt,
      sourceType: "terminal",
      sourceId: detail.terminal.terminalSessionId,
      title: "Terminal created",
      summary: detail.terminal.command || detail.terminal.cwd,
      selection: { type: "terminal", terminal: detail.terminal },
    },
  ];
  const details = new Map(
    detail.threadDetails.map((thread) => [thread.thread.threadId, thread]),
  );
  for (const ref of detail.threadRefs) {
    const thread = details.get(ref.threadId);
    if (!thread) continue;
    entries.push({
      id: `thread:${ref.threadId}`,
      occurredAt: ref.lastActivityAt,
      sourceType: "thread",
      sourceId: ref.threadId,
      title: `${ref.agent} Thread`,
      summary:
        thread.availability === "available"
          ? thread.detail?.preview || ref.status
          : thread.availability.replaceAll("_", " "),
      selection: { type: "thread", thread },
    });
    for (const turn of thread.detail?.turns ?? []) {
      const turnId = "id" in turn ? turn.id : turn.turnId;
      entries.push({
        id: `turn:${ref.threadId}:${turnId}`,
        occurredAt:
          turn.startedAt ?? turn.completedAt ?? ref.updatedAt,
        sourceType: "turn",
        sourceId: `${ref.threadId}:${turnId}`,
        title: `Turn ${turn.status}`,
        summary:
          "messages" in turn
            ? turn.messages.find((message) => message.role === "user")?.text ||
              `${turn.itemCount} recorded items`
            : turn.preview || `${turn.status} turn`,
        selection: { type: "thread", thread },
      });
    }
  }
  for (const fact of detail.facts.facts) {
    entries.push({
      id: `fact:${fact.eventId}`,
      occurredAt: fact.occurredAt,
      sourceType: "activity",
      sourceId: fact.eventId,
      title: fact.eventName,
      summary: fact.result?.status ?? fact.runtime.surface,
      selection: { type: "fact", fact },
    });
  }
  if (detail.terminal.status === "exited") {
    entries.push({
      id: `terminal:${detail.terminal.terminalSessionId}:exited`,
      occurredAt: detail.terminal.lastActivityAt,
      sourceType: "terminal",
      sourceId: `${detail.terminal.terminalSessionId}:exited`,
      title: "Terminal exited",
      summary:
        detail.terminal.exitCode === undefined
          ? "Exit code not recorded"
          : `Exit code ${detail.terminal.exitCode}`,
      selection: { type: "terminal", terminal: detail.terminal },
    });
  }
  return entries.sort(compareJournalEntries);
}

function compareJournalEntries(
  left: TerminalJournalEntry,
  right: TerminalJournalEntry,
): number {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    sourcePriority(left.sourceType) - sourcePriority(right.sourceType) ||
    left.sourceId.localeCompare(right.sourceId);
}

function sourcePriority(source: TerminalJournalEntry["sourceType"]): number {
  return { terminal: 0, thread: 1, turn: 2, activity: 3 }[source];
}
