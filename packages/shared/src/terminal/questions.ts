/** Live requests belonging to the existing terminal executor, never history previews. */
export type TerminalQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
};
export type TerminalQuestionRequest = {
  requestId: string;
  generation: string;
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  questions: TerminalQuestion[];
  state: "pending" | "submitting" | "resolved" | "expired";
};
export type TerminalQuestionsResponse = {
  capability: "available" | "unsupported" | "disconnected";
  reason: string | null;
  generation: string;
  target: { terminalId: string; panelId: string; threadId: string } | null;
  requests: TerminalQuestionRequest[];
};
export type TerminalPromptActionKind =
  | "question"
  | "permission"
  | "auth"
  | "agent_prompt";
export type TerminalQuestionNotificationResponse =
  | { status: "pending"; terminalId: string; panelId: string; questions: TerminalQuestionsResponse }
  | {
      status: "closed";
      terminalId: string;
      panelId: string;
      resolved?: true;
      terminalOnly?: true;
      actionKind?: TerminalPromptActionKind;
      title?: string;
    }
  | {
      status: "unavailable";
      terminalId: string;
      panelId: string;
      terminalOnly?: true;
      actionKind?: TerminalPromptActionKind;
      title?: string;
    };
export type AnswerTerminalQuestionRequest = {
  panelId: string;
  generation: string;
  threadId: string;
  turnId: string;
  itemId: string;
  operationId: string;
  answers: Record<string, { answers: string[] }>;
};
