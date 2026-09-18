export type RecordKind = "note" | "task";
export type TaskStatus = "open" | "done" | "archived";
export type UploadedAttachment = {
  id: string;
  kind: "image" | "markdown";
  fileName: string;
  mimeType: string;
  byteSize: number;
};
export type SuijiAttachment = UploadedAttachment & { position: number };
export type SuijiRecord = {
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
  kind: RecordKind;
  body: string;
  tags?: string[];
  attachmentIds?: string[];
};
export type EditRecord = {
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
export type RecordResponse = { record: SuijiRecord };
export type RecordPage = { items: SuijiRecord[]; nextCursor: string | null };
