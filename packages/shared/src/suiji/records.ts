import type { SuijiAttachment } from "./attachments";
import type { MaterialInput, MaterialMetadata } from "./materials";
export type { SuijiAttachment, UploadedAttachment } from "./attachments";
import type { FollowupSummary } from "./followups";
export type RecordKind = "note" | "task";
export type TaskStatus = "open" | "done" | "archived";
export type SuijiRecord = {
  material?: MaterialMetadata | null;
  followupSummary?: FollowupSummary;
  id: string;
  kind: RecordKind;
  body: string;
  /** Older responses may omit tags. Treat omission as an empty list. */
  tags?: string[];
  taskStatus: TaskStatus | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdVia: "app" | "agent";
  deletedAt?: string | null;
  attachments: SuijiAttachment[];
};
export type CreateRecord = {
  material?: MaterialInput | null;
  kind: RecordKind;
  body: string;
  tags?: string[];
  attachmentIds?: string[];
};
export type EditRecord = {
  /** Omission preserves the category; null explicitly removes it. */
  material?: MaterialInput | null;
  expectedVersion: number;
  kind?: RecordKind;
  body?: string;
  /** Omission preserves existing tags; [] clears them. */
  tags?: string[];
  attachmentIds?: string[];
};
export type ChangeTaskStatus = {
  expectedVersion: number;
  targetStatus: TaskStatus;
};
export type ChangeRecordTrash = { expectedVersion: number; trashed: boolean };
export type RecordResponse = { record: SuijiRecord; migrated?: boolean; browseEntryId?: string };
export type RecordPage = { items: SuijiRecord[]; nextCursor: string | null };
