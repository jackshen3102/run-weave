import type { TerminalCompletionEvent } from "@runweave/shared/terminal/completion";

/** Terminal lifecycle port; the push runtime owns persistence and delivery. */
export interface TerminalMobileReplies {
  expectReply(terminalId: string, panelId: string | null, text: string, sessionId: string): Promise<string | undefined>;
  cancelInput(terminalId: string, panelId: string | null, id: string): Promise<void>;
  beginTurn(terminalId: string, panelId: string | null, threadId: string | null, source: string, query?: string | null, startEventId?: string): Promise<void>;
  complete(input: Pick<TerminalCompletionEvent, "terminalSessionId" | "panelId" | "source" | "threadId" | "summary" | "completionReason" | "rawHookEvent">): Promise<void>;
}
