/** Human consumption only: these operations never authorize or invalidate knowledge. */
export type InboxSource = "evolution" | "experience";
export type InboxState = "pending" | "processed";
export interface InboxListQuery {
  state: InboxState;
  /** Omit to include both sources. Filtering happens before pagination. */
  source?: InboxSource;
  repositoryId?: string;
  limit?: number;
  cursor?: string;
}
export interface InboxRepository {
  repositoryId: string;
  displayName: string;
  projectAliases: string[];
}
export interface InboxContent {
  statement: string;
  applicability: string;
  guidance?: string[];
  actions?: string[];
  avoid?: string[];
  verification?: string[];
}
export interface InboxItem extends InboxContent {
  itemId: string;
  repositoryId: string;
  projectName: string;
  source: InboxSource;
  sourceId: string;
  sourceRevision: string;
  kind: "finding" | "suggestion" | "experience";
  title: string;
  validationLabel: string;
  contentVersion: string;
  contentUpdatedAt: string;
  stateVersion: number;
  processedAt: string | null;
  hasUpdate: boolean;
  availability: "available" | "unavailable" | "unknown";
  /** Present on a processed snapshot when the current content has changed. */
  currentContentVersion?: string;
}
export interface InboxSourceStatus {
  status: "ok" | "partial";
  evolution: "available" | "unavailable";
  experience: "available" | "unavailable";
}
export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
  sourceStatus: InboxSourceStatus;
  repositories: InboxRepository[];
}
export interface InboxStateChange {
  state: InboxState;
  expectedContentVersion: string;
  expectedStateVersion: number;
}
