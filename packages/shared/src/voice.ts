export interface TranscribeVoiceRequest {
  mimeType: "audio/wav";
  audioBase64: string;
  sampleRateHz: 24_000;
  durationMs: number;
}

export interface TranscribeVoiceResponse {
  text: string;
}
