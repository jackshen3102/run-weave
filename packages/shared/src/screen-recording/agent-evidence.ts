export interface ScreenAgentEvent {
  id: string; provider: string; threadID: string; eventID: string; projectID: string | null;
  occurredAtMs: number; kind: 'assistant' | 'tool'; text: string; derived: boolean;
  independentSuccess: boolean;
}
export interface ScreenAgentEventPage {
  events: ScreenAgentEvent[]; nextCursor: string; coverage: 'complete' | 'partial' | 'unavailable';
  bytes: number; sourceVersion?: string;
}
