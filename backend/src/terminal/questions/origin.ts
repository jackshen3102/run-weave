import type {
  TerminalPromptActionKind,
  TerminalQuestionRequest,
  TerminalQuestionsResponse,
} from "@runweave/shared/terminal/questions";

export type TerminalQuestionEnd = "closed" | "resolved";

export type TerminalQuestionOrigin = {
  terminalId: string;
  panelId: string;
  threadId: string;
  turnId: string;
  itemId: string;
};

export type TerminalPromptObservation = {
  terminalId: string;
  panelId: string | null;
  source: string;
  actionKind: TerminalPromptActionKind;
  dedupeKey: string;
  title: string;
  body: string;
  specificity: number;
  settleMs?: number;
  toolUseId?: string;
};

export interface TerminalMobilePrompts {
  observePrompt(input: TerminalPromptObservation): void;
  resolvePrompt(
    terminalId: string,
    panelId: string | null,
    state: TerminalQuestionEnd,
    match?: { toolUseId?: string; onlySource?: string },
  ): void;
  closeTerminal(terminalId: string): void;
}

export type OriginalTerminalQuestion =
  | { status: "closed" | "unavailable" | "unsupported" }
  | { status: "available"; request: TerminalQuestionRequest | undefined; value: TerminalQuestionsResponse };
