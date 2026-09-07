import type { RecordKind, TaskStatus } from "./records";

export type ReviewScope =
  | { kind: "all" | "open" }
  | { kind: "record"; recordId: string };
export type ReviewInput = {
  question: string;
  scope: ReviewScope;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
};
export type ReviewCitation = {
  recordId: string;
  version: number;
  kind: RecordKind;
  taskStatus: TaskStatus | null;
  createdAt: string;
  quote: string;
  attachment?: {
    id: string;
    fileName: string;
    mimeType: string;
    offset?: number;
  };
};
export type ReviewAnswer = {
  text: string;
  citations: ReviewCitation[];
  coverage: {
    mode: "agent-keyword";
    scope: ReviewScope;
    listedRecords: number;
    readRecords: number;
    attachmentReads: number;
    semanticIndex: false;
    externalLinks: false;
  };
};
export type SuijiReview = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  answer?: ReviewAnswer;
  error?: string;
};
