import type { TerminalAgentKind } from "./runtime/state.js";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  rawTurnId?: string;
  phase?: "commentary" | "final";
}

export interface ConversationTurn {
  id: string;
  messages: ConversationMessage[];
  rawTurnId?: string;
}

export type ConversationAvailability =
  | "available"
  | "no_thread"
  | "provider_unsupported"
  | "source_missing";

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

/** Bounded semantic projection for monitoring; never a replacement for the full conversation UI. */
export interface SupervisionConversationResponse extends AppServerConversationResponse {
  indexing: boolean;
  sourceVersion?: string;
  scannedBytes?: number;
  sourceBytes?: number;
  runtimeError?: { turnId?: string; code: string; message: string };
}
