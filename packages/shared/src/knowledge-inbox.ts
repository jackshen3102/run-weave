import type { ContextPackEvidenceRef, EvolutionClaim, EvolutionCrossReview, InsightRevision } from "./evolution/index";
import type { ExperienceRecord, ExperienceFeedback } from "./experience";

/** Consumption only: these operations never authorize or invalidate knowledge. */
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
  /** Exact source revision, independent of the public body's version hash. */
  sourceRevisionId?: string;
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

/** An authenticated locator, never a bearer credential or an arbitrary URL. */
export const KNOWLEDGE_REFERENCE_PATTERN = /^rw-knowledge:v1:([a-f0-9-]{36}):([a-f0-9-]{36})$/u;
export interface KnowledgeShareRequest {
  contentVersion: string;
  sourceRevision: string;
}
export interface KnowledgeShareResult {
  reference: string;
  text: string;
}
export interface KnowledgeMaterial {
  warnings: string[];
  evolution?: {
    revision: InsightRevision;
    claims: EvolutionClaim[];
    reviews: EvolutionCrossReview[];
    evidence: ContextPackEvidenceRef[];
  };
  experience?: {
    record: ExperienceRecord;
    feedback: ExperienceFeedback[];
  };
}
export interface KnowledgeSnapshot {
  createdAt: string;
  item: InboxItem;
  material: KnowledgeMaterial;
}
export interface KnowledgeReadResult {
  reference: string;
  createdAt: string;
  item: InboxItem;
  current: {
    availability: InboxItem["availability"];
    contentVersion?: string;
    sourceRevision?: string;
    reason?: string;
  };
  material?: KnowledgeMaterial;
  /** Live Activity contents, fetched with normal authenticated content reads by the CLI. */
  contents?: Array<{
    contentId: string;
    status: "available" | "unavailable";
    text?: string;
    truncated?: boolean;
    reason?: string;
  }>;
}
