export const TERMINAL_TEXT_ATTACHMENT_LIMITS = {
  threshold: 5000,
  maxBytes: 1024 * 1024,
  sessionMaxBytes: 100 * 1024 * 1024,
  maxDraftAttachments: 20,
} as const;

export interface TerminalTextAttachmentCapability {
  enabled: boolean;
  provider: "codex" | null;
  threadId: string | null;
  executionHost: "backend-local" | null;
  reason: string | null;
  limits: typeof TERMINAL_TEXT_ATTACHMENT_LIMITS;
}

export interface TerminalTextAttachment {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  panelId: string;
  threadId: string | null;
  operationId: string;
  purpose: "composer" | "tui";
  utf16Length: number;
  utf8Bytes: number;
  sha256: string;
  createdAt: string;
  retainedAt: string;
  state: "draft" | "referenced";
  filePath: string;
  tuiReference: string;
  insertOperationId: string;
}

export interface CreateTerminalTextAttachmentRequest {
  operationId: string;
  panelId: string;
  expectedThreadId?: string | null;
  purpose: "composer" | "tui";
  text: string;
  /** Qualification captured before rich-paste resource preparation. */
  preparationId?: string;
}

export interface TerminalPastePreparation {
  preparationId: string;
  expiresAt: number;
}

export interface InsertTerminalTextAttachmentRequest {
  /** Paste short rich content inline rather than the managed file reference. */
  inline?: boolean;
  operationId: string;
  panelId: string;
  expectedThreadId?: string | null;
}

export interface TerminalTextAttachmentOperation {
  operationId: string;
  kind: "create" | "insert" | "composer";
  status: "saved" | "dispatching" | "accepted" | "rejected" | "unknown";
  attachmentIds: string[];
  reason?: string;
}
