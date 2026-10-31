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
  availableUntilMs: number;
}
export interface ScreenRecordingInterval {
  startMs: number;
  endMs: number;
  kind: 'privacy' | 'paused' | 'systemInactive' | 'error' | 'unknown';
}
export interface ScreenRecordingStatus {
  version: 1;
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
  range: ScreenRecordingRange;
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
export type ScreenRecordingMethod = 'status' | 'days' | 'ranges' | 'thumbnail' | 'openView' | 'availability' | 'frame' | 'closeView';
export interface ScreenRecordingSocketRequest {
  version: 1;
  requestId: string;
  method: ScreenRecordingMethod;
  params: Record<string, string | number>;
  payloadLength: 0;
}
export interface ScreenRecordingSocketResponse {
  requestId: string;
  status: number;
  code: string;
  payloadLength: number;
  contentType: 'application/json' | 'image/jpeg';
  serverEpoch: string;
}
