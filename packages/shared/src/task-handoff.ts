/** A handoff is advisory context, never a certification of task completion. */
export interface TaskHandoffTarget {
  terminalSessionId: string;
  panelId: string | null;
  threadId: string;
}
export interface TaskHandoffEvidence {
  id: string;
  kind: "user" | "assistant" | "agent.tool.requested" | "agent.tool.completed";
  text: string;
  occurredAt: string;
  toolUseId: string | null;
  truncated: boolean;
}
export interface TaskHandoffItem {
  text: string;
  evidenceIds: string[];
}
export interface TaskHandoffCard {
  target: TaskHandoffTarget;
  revision: number;
  updatedAt: string;
  goal: string;
  goalEdited: boolean;
  goalEditedAt?: string;
  results: TaskHandoffItem[];
  pending: string[];
  nextStep: string;
  evidence: TaskHandoffEvidence[];
  limitations: string[];
  /** Native completed turns incorporated into this advisory record. */
  turnIds: string[];
}
export interface TaskHandoffResponse {
  target: TaskHandoffTarget | null;
  status: "empty" | "updating" | "ready" | "error" | "unsupported" | "running";
  card: TaskHandoffCard | null;
  message?: string;
  canContinue?: boolean;
}
