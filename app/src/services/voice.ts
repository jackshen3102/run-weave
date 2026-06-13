import type {
  TranscribeVoiceRequest,
  TranscribeVoiceResponse,
} from "@runweave/shared";

import { requestJson } from "./http";

export async function transcribeVoice(
  apiBase: string,
  accessToken: string,
  payload: TranscribeVoiceRequest,
): Promise<TranscribeVoiceResponse> {
  return requestJson<TranscribeVoiceResponse>(
    apiBase,
    "/api/voice/transcribe",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}
