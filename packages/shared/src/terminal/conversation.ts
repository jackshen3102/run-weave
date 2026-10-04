import type { TerminalAgentKind } from "./runtime/state.js";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
}

export interface ConversationTurn {
  id: string;
  messages: ConversationMessage[];
}

export type ConversationAvailability =
  | "available" | "no_thread" | "provider_unsupported" | "source_missing";

export interface ConversationContent {
  availability: ConversationAvailability;
  readAt: string;
  partial: boolean;
  turns: ConversationTurn[];
}

export interface AppServerConversationResponse extends ConversationContent {
  threadId: string;
  provider: string;
}

export interface ConversationTarget {
  terminalSessionId: string;
  panelId: string | null;
  threadId: string;
  provider: TerminalAgentKind;
}

export interface TerminalConversationResponse extends ConversationContent {
  target: ConversationTarget | null;
}
