/** Native Agent transcripts are the only content source. All offsets are UTF-8 bytes. */
export type SessionSearchProvider = "codex" | "pi" | "claude";
export type SessionSearchLevel = "chat" | "work" | "full";
export type SessionSearchOrigin = "interactive" | "background" | "subagent" | "review" | "unknown";
export type SessionSearchKind = "user" | "assistant" | "request" | "result" | "file_change" | "context";

export interface NativeRecordLocation {
  path: string;
  line: number;
  byteOffset: number;
  byteLength: number;
  sha256: string;
}

export interface SessionSearchQuery {
  query: string;
  /** Read the existing index without refreshing it. */
  noUpdate?: boolean;
  /** A registered project is required; all-project searches must be explicit. */
  projectId?: string;
  cwd?: string;
  allProjects?: boolean;
  provider?: SessionSearchProvider;
  level?: SessionSearchLevel;
  includeOtherOrigins?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface SessionSearchSourceStatus {
  provider: SessionSearchProvider;
  status: "ready" | "indexing" | "unavailable" | "partial";
  files: number;
  sessions: number;
  indexedAt: string | null;
  issues: string[];
}

export interface SessionSearchStatus {
  node: string;
  state: "starting" | "ready" | "indexing" | "unavailable";
  generation: number;
  lastScanAt: string | null;
  sources: SessionSearchSourceStatus[];
  metrics: { sourceBytesRead: number; parsedBytes: number; unchanged: number; appended: number; rebuilt: number };
  error?: string;
}

export interface SessionSearchHit {
  id: string;
  sessionId: string;
  threadId: string;
  provider: SessionSearchProvider;
  projectPath: string;
  repositoryId: string | null;
  title: string;
  origin: SessionSearchOrigin;
  occurredAt: string | null;
  kind: SessionSearchKind;
  text: string;
  callId: string | null;
  toolName: string | null;
  location: NativeRecordLocation;
}

export interface SessionSearchResponse {
  query: string;
  level: SessionSearchLevel;
  hits: SessionSearchHit[];
  nextCursor: string | null;
  partial: boolean;
  /** Same snapshot generation is required when following a cursor. */
  coverage: SessionSearchStatus;
}

export interface SessionSearchContext {
  hit: SessionSearchHit;
  records: SessionSearchHit[];
  /** Pairing is by the native call ID, never inferred from assistant prose. */
  paired: SessionSearchHit[];
  sourceState: "verified" | "changed" | "missing";
  partial: boolean;
}
