/** Independent message side chat. Never carried over the terminal byte stream. */
export type SideChatStatus = "creating" | "active" | "ending" | "ended" | "unavailable";
export type SideChatTurnState = "accepted" | "running" | "stopping" | "completed" | "stopped" | "failed" | "unknown";
export interface SideChatSourceRef {
  terminalSessionId: string;
  panelId: string;
  expectedPrimaryThreadId: string;
  lastCompletedTurnId: string;
}
export interface SideChatSourceSnapshot extends SideChatSourceRef {
  turnNumber?: number;
  model: string;
  cwd: string;
  preview: Array<{ role: "user" | "assistant"; text: string }>;
  permissions: string;
}
export interface SideChat {
  id: string;
  source: SideChatSourceSnapshot;
  status: SideChatStatus;
  version: number;
  createdAt: string;
  endedAt: string | null;
}
export interface SideChatTurn {
  id: string;
  sideChatId: string;
  clientOperationId: string;
  state: SideChatTurnState;
  acceptedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
}
export interface SideChatMessage {
  id: string;
  sideChatId: string;
  sequence: number;
  turnId: string;
  turnState?: SideChatTurnState;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}
export interface SideChatMessagePage {
  messages: SideChatMessage[];
  beforeSequence: number | null;
}
export interface SideChatSnapshot extends SideChatMessagePage {
  sideChat: SideChat;
  currentTurn: SideChatTurn | null;
  readAt: string;
  sourceStatus: "running" | "idle" | "unavailable" | "unknown";
}
export interface SideChatCapabilities {
  supported: boolean;
  reason: string | null;
  source: SideChatSourceRef | null;
  activeSideChatId: string | null;
}
export interface SideChatOperation {
  operationId: string;
  sideChatId: string;
  kind: "create" | "turn" | "stop" | "end";
  state: "accepted" | "completed" | "unknown";
  turnId: string | null;
  version: number;
}
export interface CreateSideChatRequest { operationId: string; source: SideChatSourceRef }
export interface SideChatWriteRequest { operationId: string; expectedVersion: number }
export interface SendSideChatRequest extends SideChatWriteRequest { text: string }
export interface SideChatWriteResponse { operation: SideChatOperation; version: number; turnId: string | null }
export interface CreateSideChatResponse extends SideChatWriteResponse { sideChat: SideChat }
export const SIDE_CHAT_TEXT_MAX_BYTES = 65_536;
export const SIDE_CHAT_BUSY_STATES: readonly SideChatTurnState[] = ["accepted", "running", "stopping", "unknown"];
