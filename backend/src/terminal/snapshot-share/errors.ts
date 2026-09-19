import type { TerminalSnapshotShareErrorCode } from "@runweave/shared/terminal/snapshot-share";

const errors = {
  SNAPSHOT_TARGET_NOT_FOUND: [404, "Terminal session or panel not found"],
  SNAPSHOT_TARGET_UNAVAILABLE: [409, "Terminal panel cannot be captured"],
  SNAPSHOT_CAPTURE_UNAVAILABLE: [503, "Terminal capture is unavailable"],
  SNAPSHOT_TOO_LARGE: [413, "Terminal snapshot exceeds 10 MiB"],
  SNAPSHOT_BUSY: [429, "Too many snapshot creations in progress"],
  SNAPSHOT_STORAGE_FULL: [507, "Terminal snapshot storage is full"],
  SNAPSHOT_STORAGE_FAILED: [500, "Terminal snapshot could not be saved"],
} as const;

export class TerminalSnapshotShareError extends Error {
  readonly status: number;

  constructor(readonly code: TerminalSnapshotShareErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}
