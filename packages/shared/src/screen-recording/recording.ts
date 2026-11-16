/** ScreenJournal v1. Times are integer UTC milliseconds; no storage paths cross this boundary. */
export const SCREEN_RECORDING_VERSION = 1 as const;
export type ScreenRecordingVariant = 'thumb' | 'preview' | 'full';
export type ScreenRecordingAvailability = 'ready' | 'notRunning' | 'unsupported' | 'incompatible';
export interface ScreenRecordingError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface ScreenRecordingDay {
  day: string;
  startMs: number;
  endMs: number;
}
export interface ScreenRecordingRange {
  rangeID: string;
  startMs: number;
  endMs: number;
  displayID: number;
  sampleCount: number;
  previewCaptureID?: string | null;
  state: 'ready';
  /** Capture signal only; quiet does not establish that no work occurred. */
  activityKind?: 'active' | 'quiet' | 'privacy' | 'passive' | 'unknown' | null;
  transientChangeCount?: number | null;
}
/** Best-effort capture-time context; absent for old/private/ambiguous frames.
 * URL is an HTTP(S) AX document URL with credentials, query and fragment removed.
 */
export interface ScreenRecordingAXText { key: string; role: string; text: string }
export interface ScreenRecordingAXDelta {
  kind: 'baseline' | 'changed' | 'unchanged';
  baseCaptureID?: string | null;
  baseHash?: string | null;
  contentHash: string;
  texts: ScreenRecordingAXText[];
  removed: string[];
  truncated: boolean;
}
export interface ScreenRecordingCaptureContext {
  windowID: number;
  accessibility?: ScreenRecordingAXDelta | null;
  accessibilityUnavailableReason?: string | null;
  windowTitle?: string | null;
  url?: string | null;
}
export interface ScreenRecordingCapture {
  id: string;
  sessionID: string;
  sequence: number;
  capturedAtMs: number;
  timezoneOffsetSeconds: number;
  displayID: number;
  frontmostApplication?: { id?: string | null; name?: string | null } | null;
  privacyPlaceholder: boolean;
  idleSeconds?: number | null;
  /** Absent on older captures; unknown must not be treated as unchanged. */
  visualChanged?: boolean | null;
  availableUntilMs: number;
  context?: ScreenRecordingCaptureContext | null;
}
export interface ScreenRecordingInterval {
  startMs: number;
  endMs: number;
  kind: 'privacy' | 'paused' | 'systemInactive' | 'error' | 'unknown';
}
export interface ScreenRecordingStatus {
  version: 1;
  analysisVersion?: 1;
  availability: ScreenRecordingAvailability;
  deviceID?: string;
  deviceName?: string;
  timeZone?: string;
  serverEpoch?: string;
  catalogRevision?: string;
  captureState?: string;
  retentionDays?: number;
  days?: ScreenRecordingDay[];
  latestReadyMs?: number | null;
  hasPending?: boolean;
  intervals?: ScreenRecordingInterval[] | null;
}
export interface ScreenRecordingPage<T> {
  items: T[];
  catalogRevision: string;
  nextCursor?: string | null;
}
export interface ScreenRecordingView {
  viewID: string;
  serverEpoch: string;
  deviceID: string;
  /** Bounded evidence window, at most 900 captures (also safe for older clients). */
  range: ScreenRecordingRange;
  /** Frozen logical interval; may span multiple evidence windows. */
  timelineRange?: ScreenRecordingRange | null;
  pageOffset?: number | null;
  captures: ScreenRecordingCapture[];
  intervals: ScreenRecordingInterval[];
  expiresAt: number;
}
export interface ScreenRecordingViewAvailability {
  checkedAt: number;
  expiresAt: number;
  invalidCaptureIDs: string[];
  intervals: ScreenRecordingInterval[];
  viewState: 'ready' | 'gone';
}
/** Download framing: uint32 BE manifest length, UTF-8 manifest, then MP4 assets in manifest order. */
export interface ScreenRecordingPackage {
  version: 1;
  viewID: string;
  serverEpoch: string;
  deviceID: string;
  expiresAt: number;
  assets: { id: string; byteLength: number; sha256: string; width: number; height: number }[];
  frames: { captureID: string; assetID: string; frameIndex: number }[];
}
export type ScreenRecordingReadMethod = 'status' | 'days' | 'ranges' | 'thumbnail' | 'openView' | 'availability' | 'frame' | 'closeView' | 'packageManifest' | 'packageMedia';
export interface ScreenRecordingSocketResponse {
  requestId: string;
  status: number;
  code: string;
  payloadLength: number;
  contentType: 'application/json' | 'image/jpeg' | 'application/octet-stream';
  serverEpoch: string;
}
