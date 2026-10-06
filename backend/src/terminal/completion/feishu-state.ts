interface Turn {
  id: string;
  startEventId?: string;
  threadId: string | null;
  source: string;
  startedAt: number;
  completed: boolean;
  feishuReply: boolean;
}

interface Completion {
  panelId: string | null;
  turnId: string | null;
  dueAt: number;
  bypass: boolean;
  seen: boolean;
  claimed: boolean;
}

/** Backend-only persisted projection, scoped to one terminal and its exact panels. */
export interface FeishuNotificationState {
  turns: Record<string, Turn>;
  inputs: Record<string, { hash: string; expiresAt: number; operationId: string }>;
  completions: Record<string, Completion>;
}

