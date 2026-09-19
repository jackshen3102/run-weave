export interface TerminalSnapshotShareAccess {
  snapshotId: string;
  /** Signed absolute expiry, Unix epoch milliseconds. */
  expires: number;
  signature: string;
}

// Canonical URL only: reject duplicate/unknown fields, alternate encodings and fragments.
const SIGNED_SHARE_PATH = /^\/share\/terminal\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\?expires=([1-9][0-9]{0,15})&signature=([A-Za-z0-9_-]{43})$/;

export function parseTerminalSnapshotSharePath(value: string): TerminalSnapshotShareAccess | null {
  const match = SIGNED_SHARE_PATH.exec(value);
  if (!match || match[0] !== value) return null;
  const expires = Number(match[2]);
  return Number.isSafeInteger(expires)
    ? { snapshotId: match[1]!, expires, signature: match[3]! }
    : null;
}

export interface CreateTerminalSnapshotShareResponse {
  /** Relative signed read URL; preserve its expires/signature query parameters. */
  sharePath: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  lineCount: number;
}

export type TerminalSnapshotShareErrorCode =
  | "SNAPSHOT_TARGET_NOT_FOUND"
  | "SNAPSHOT_TARGET_UNAVAILABLE"
  | "SNAPSHOT_CAPTURE_UNAVAILABLE"
  | "SNAPSHOT_TOO_LARGE"
  | "SNAPSHOT_BUSY"
  | "SNAPSHOT_STORAGE_FULL"
  | "SNAPSHOT_STORAGE_FAILED";

export interface TerminalSnapshotShareErrorResponse {
  message: string;
  code: TerminalSnapshotShareErrorCode;
}
