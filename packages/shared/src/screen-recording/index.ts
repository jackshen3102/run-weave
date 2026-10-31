export * from './recording';
export * from './agent-evidence';
export * from './analysis';
export type ScreenRecordingMethod = import('./recording').ScreenRecordingReadMethod | import('./analysis').AnalysisMethod;
export interface ScreenRecordingSocketRequest {
  version: 1;
  requestId: string;
  method: ScreenRecordingMethod;
  params: Record<string, string | number>;
  payloadLength: 0;
}
