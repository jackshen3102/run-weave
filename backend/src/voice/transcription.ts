import type {
  TranscribeVoiceRequest,
  TranscribeVoiceResponse,
} from "@browser-viewer/shared";
import { codexAppServerClient } from "./codex-app-server-client";

const CHATGPT_TRANSCRIPTIONS_URL = "https://chatgpt.com/backend-api/transcribe";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_MS = 150_000;
const TRANSCRIPTION_FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSCRIPTION_LANGUAGE = "zh";
const DEFAULT_TRANSCRIPTION_PROMPT = "请使用简体中文输出转写文本。";
const DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

interface VoiceAuthStatus {
  authMethod?: string;
  authToken?: string;
}

export class VoiceTranscriptionError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly providerRequestId: string | null = null,
    readonly providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "VoiceTranscriptionError";
  }
}

export async function transcribeVoice(
  request: TranscribeVoiceRequest,
): Promise<TranscribeVoiceResponse> {
  validateRequestShape(request);
  const audioBuffer = decodeAudioBase64(request.audioBase64);
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new VoiceTranscriptionError(
      413,
      "audio_too_large",
      "Voice audio exceeds the 10 MB limit.",
    );
  }
  validateWav(audioBuffer);

  const token = await resolveChatGptToken();
  const formData = new FormData();
  const audioArrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength,
  ) as ArrayBuffer;
  formData.append(
    "file",
    new Blob([audioArrayBuffer], { type: request.mimeType }),
    "voice.wav",
  );
  appendOptionalFormField(
    formData,
    "language",
    readVoiceConfig("RUNWEAVE_VOICE_TRANSCRIPTION_LANGUAGE") ||
      DEFAULT_TRANSCRIPTION_LANGUAGE,
  );
  appendOptionalFormField(
    formData,
    "prompt",
    readVoiceConfig("RUNWEAVE_VOICE_TRANSCRIPTION_PROMPT") ||
      DEFAULT_TRANSCRIPTION_PROMPT,
  );

  const response = await fetchChatGptTranscription(token, formData);
  const providerRequestId = readProviderRequestId(response);

  if (!response.ok) {
    const providerMessage = await readProviderError(response);
    if (response.status === 401 || response.status === 403) {
      throw new VoiceTranscriptionError(
        401,
        "auth_rejected",
        "ChatGPT login has expired on this Mac. Sign in again, then retry voice transcription.",
        providerRequestId,
        response.status,
      );
    }
    throw new VoiceTranscriptionError(
      502,
      "transcription_failed",
      providerMessage ||
        `ChatGPT transcription failed with status ${response.status}.`,
      providerRequestId,
      response.status,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    text?: unknown;
    transcript?: unknown;
  } | null;
  const text = readString(payload?.text) || readString(payload?.transcript);
  if (!text) {
    throw new VoiceTranscriptionError(
      502,
      "transcription_invalid_response",
      "ChatGPT transcription response did not include text.",
      providerRequestId,
      response.status,
    );
  }

  return { text };
}

async function fetchChatGptTranscription(
  token: string,
  formData: FormData,
): Promise<Response> {
  try {
    return await fetch(CHATGPT_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Language":
          readVoiceConfig("RUNWEAVE_VOICE_TRANSCRIPTION_ACCEPT_LANGUAGE") ||
          DEFAULT_ACCEPT_LANGUAGE,
        Authorization: `Bearer ${token}`,
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      body: formData,
      signal: AbortSignal.timeout(TRANSCRIPTION_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new VoiceTranscriptionError(
        504,
        "voice_transcription_timeout",
        "ChatGPT transcription request timed out.",
      );
    }
    throw error;
  }
}

function appendOptionalFormField(
  formData: FormData,
  name: string,
  value: string,
): void {
  const normalized = value.trim();
  if (normalized) {
    formData.append(name, normalized);
  }
}

function readVoiceConfig(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateRequestShape(request: TranscribeVoiceRequest): void {
  if (request.mimeType !== "audio/wav") {
    throw new VoiceTranscriptionError(
      400,
      "unsupported_mime_type",
      "Only WAV voice audio is supported.",
    );
  }
  if (request.sampleRateHz !== 24_000) {
    throw new VoiceTranscriptionError(
      400,
      "unsupported_sample_rate",
      "Voice audio must be 24 kHz mono WAV.",
    );
  }
  if (!Number.isFinite(request.durationMs) || request.durationMs <= 0) {
    throw new VoiceTranscriptionError(
      400,
      "invalid_duration",
      "Voice audio must include a positive duration.",
    );
  }
  if (request.durationMs > MAX_DURATION_MS) {
    throw new VoiceTranscriptionError(
      400,
      "duration_too_long",
      "Voice audio must be 150 seconds or shorter.",
    );
  }
}

async function resolveChatGptToken(): Promise<string> {
  let payload: unknown;
  try {
    payload = await codexAppServerClient.sendRequest("getAuthStatus", {
      includeToken: true,
      refreshToken: true,
    });
  } catch (error) {
    throw new VoiceTranscriptionError(
      503,
      "codex_app_server_unavailable",
      error instanceof Error
        ? `Could not read Codex auth from this Mac: ${error.message}`
        : "Could not read Codex auth from this Mac.",
    );
  }

  const authStatus = payload as VoiceAuthStatus | null;
  const authMethod = readString(authStatus?.authMethod);
  const token = normalizeBearerToken(authStatus?.authToken);
  if (!token) {
    throw new VoiceTranscriptionError(
      401,
      "token_missing",
      "No ChatGPT session token is available from Codex on this Mac.",
    );
  }
  if (!isChatGptAuthMethod(authMethod)) {
    throw new VoiceTranscriptionError(
      400,
      "not_chatgpt",
      "Voice transcription requires Codex to be signed in with ChatGPT on this Mac.",
    );
  }
  return token;
}

function decodeAudioBase64(value: string): Buffer {
  const normalized =
    typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
  if (!normalized) {
    throw new VoiceTranscriptionError(
      400,
      "missing_audio",
      "Voice request did not include audio.",
    );
  }
  if (normalized.length % 4 !== 0) {
    throw new VoiceTranscriptionError(
      400,
      "invalid_audio",
      "Voice audio could not be decoded.",
    );
  }
  const audioBuffer = Buffer.from(normalized, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalized) {
    throw new VoiceTranscriptionError(
      400,
      "invalid_audio",
      "Voice audio could not be decoded.",
    );
  }
  return audioBuffer;
}

function validateWav(buffer: Buffer): void {
  const wavInfo = readWavInfo(buffer);
  if (!wavInfo) {
    throw new VoiceTranscriptionError(
      400,
      "invalid_audio",
      "Voice audio is not a valid WAV file.",
    );
  }
  if (
    wavInfo.audioFormat !== 1 ||
    wavInfo.channelCount !== 1 ||
    wavInfo.sampleRateHz !== 24_000 ||
    wavInfo.bitsPerSample !== 16
  ) {
    throw new VoiceTranscriptionError(
      400,
      "unsupported_sample_rate",
      "Voice audio must be 24 kHz mono WAV.",
    );
  }
}

function readWavInfo(buffer: Buffer): {
  audioFormat: number;
  channelCount: number;
  sampleRateHz: number;
  bitsPerSample: number;
} | null {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let offset = 12;
  let info: ReturnType<typeof readWavInfo> = null;
  let hasData = false;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > buffer.length) {
      return null;
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        return null;
      }
      info = {
        audioFormat: buffer.readUInt16LE(payloadStart),
        channelCount: buffer.readUInt16LE(payloadStart + 2),
        sampleRateHz: buffer.readUInt32LE(payloadStart + 4),
        bitsPerSample: buffer.readUInt16LE(payloadStart + 14),
      };
    } else if (chunkId === "data") {
      hasData = chunkSize > 0;
    }

    offset = payloadEnd + (chunkSize % 2);
  }

  return info && hasData ? info : null;
}

async function readProviderError(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
    message?: unknown;
  } | null;
  return readString(payload?.error?.message) || readString(payload?.message);
}

function readProviderRequestId(response: Response): string | null {
  return readString(response.headers.get("x-oai-request-id"));
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBearerToken(value: unknown): string | null {
  const token = readString(value);
  if (!token) {
    return null;
  }
  const match = token.match(/^bearer\s+(.+)$/i);
  return match ? match[1]?.trim() || null : token;
}

function isChatGptAuthMethod(value: string | null): boolean {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return normalized.includes("chatgpt");
}
