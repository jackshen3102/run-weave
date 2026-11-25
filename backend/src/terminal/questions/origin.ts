import type { TerminalQuestionRequest, TerminalQuestionsResponse } from "@runweave/shared/terminal/questions";

export type TerminalQuestionEnd = "closed" | "resolved";

export type TerminalQuestionOrigin = {
  terminalId: string;
  panelId: string;
  threadId: string;
  turnId: string;
  itemId: string;
};

export type OriginalTerminalQuestion =
  | { status: "closed" | "unavailable" }
  | { status: "available"; request: TerminalQuestionRequest | undefined; value: TerminalQuestionsResponse };
