import { Router } from "express";
import { z } from "zod";
import type { TranscribeVoiceRequest } from "@runweave/shared";
import { logger } from "../logging";
import {
  transcribeVoice,
  VoiceTranscriptionError,
} from "../voice/transcription";

const voiceLogger = logger.child({ component: "voice" });

const transcribeVoiceSchema = z.object({
  mimeType: z.literal("audio/wav"),
  audioBase64: z.string().min(1),
  sampleRateHz: z.literal(24_000),
  durationMs: z.number().finite().positive(),
});

export function createVoiceRouter(): Router {
  const router = Router();

  router.post("/transcribe", async (req, res) => {
    const parsed = transcribeVoiceSchema.safeParse(
      req.body as TranscribeVoiceRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const payload = await transcribeVoice(parsed.data);
      res.json(payload);
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) {
        voiceLogger.warn("voice.transcribe.failed", {
          message: "Voice transcription failed",
          errorCode: error.errorCode,
          providerRequestId: error.providerRequestId,
          providerStatus: error.providerStatus,
          error,
        });
        res.status(error.status).json({
          message: error.message,
          errorCode: error.errorCode,
        });
        return;
      }

      voiceLogger.error("voice.transcribe.unexpected", {
        message: "Unexpected voice transcription failure",
        error,
      });
      res.status(500).json({
        message: "Voice transcription failed",
        errorCode: "voice_transcription_failed",
      });
    }
  });

  return router;
}
