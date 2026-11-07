import type { SuijiAttachment } from "./records";

/** Browsing has its own storage, revisions and credentials; never a work fact. */
export type BrowseSource = {
  provider: string;
  displayName: string;
  connectionId: string | null;
};
export type BrowseContentType =
  | "article"
  | "answer"
  | "image"
  | "text"
  | "link"
  | "chat-fragment"
  | "app-usage";
export type BrowseContentState = {
  state: "available" | "metadata-only" | "unavailable";
  reason: string | null;
};
export type BrowseEntryInput = {
  captureId: string;
  browseDate: string;
  occurredAt: string | null;
  capturedAt: string;
  title: string;
  body: string;
  userNote: string;
  source: BrowseSource;
  contentType: string;
  captureMethod: "connector" | "share" | "picker" | "manual" | "legacy";
  sourceUrl: string | null;
  contentState: BrowseContentState;
  attachmentIds: string[];
};
export type BrowseEntry = Omit<BrowseEntryInput, "attachmentIds"> & {
  id: string;
  version: number;
  contentHash: string;
  deletedAt: string | null;
  attachments: SuijiAttachment[];
};
export type BrowseConnection = {
  id: string;
  provider: string;
  externalAccountId: string;
  machine: string;
  profile: string;
  group: string;
  state: "active" | "disabled";
  lastSuccessAt: string | null;
};
export type BrowseObservation = {
  contentType: string;
  contentId: string;
  readTime: string;
  observedAt: string;
};
export type BrowseImport = {
  runId: string;
  connectionId: string;
  externalAccountId: string;
  from: string;
  to: string;
  identityBefore: string;
  identityAfter: string;
  coverage: {
    state: "complete" | "partial";
    pages: number;
    metadata: number;
    content: number;
    errors: string[];
  };
  items: { observation: BrowseObservation; entry: BrowseEntryInput }[];
};
export type BrowseRun = {
  runId: string;
  connectionId: string;
  from: string;
  to: string;
  coverage: BrowseImport["coverage"];
  receipt: {
    created: number;
    updated: number;
    unchanged: number;
    browseRevision: string;
  };
};
export type BrowseEntryRef = { id: string; version: number; hash: string };
export type BrowseDigestInput = {
  date: string;
  connectionId: string;
  title: string;
  body: string;
  entryRefs: BrowseEntryRef[];
  inputRevision: string;
};
export type BrowseDigest = BrowseDigestInput & {
  id: string;
  version: number;
  state: "current" | "stale";
};
export type BrowsePage = {
  items: BrowseEntrySummary[];
  sources?: BrowseSource[];
  digests?: BrowseDigest[];
  dayCounts: { date: string; count: number }[];
  nextCursor: string | null;
  browseRevision: string;
};
export type BrowseEntrySummary = Omit<BrowseEntry, "body"> & {
  excerpt: string;
  bodyScalars: number;
};
export type BrowseContentPage = {
  id: string;
  version: number;
  contentHash: string;
  text: string;
  offset: number;
  totalScalars: number;
  nextOffset: number | null;
};
