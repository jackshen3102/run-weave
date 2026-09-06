import type { TerminalBrowserProfileId } from "./profile";

export interface BrowserAssistanceTarget {
  profileId: TerminalBrowserProfileId;
  browserGroupId: string;
  targetId: string;
}

export interface CreateBrowserAssistanceRequest extends BrowserAssistanceTarget {
  panelId: string;
  reason: string;
}

export type BrowserAssistanceState =
  | "requesting"
  | "waiting"
  | "resume_pending"
  | "acknowledged"
  | "cancelled"
  | "expired"
  | "invalidated"
  | "delivery_unknown";

export interface BrowserAssistanceRequest extends CreateBrowserAssistanceRequest {
  requestId: string;
  terminalSessionId: string;
  threadId: string;
  state: BrowserAssistanceState;
  createdAt: string;
  expiresAt: string;
  resumedAt: string | null;
}
