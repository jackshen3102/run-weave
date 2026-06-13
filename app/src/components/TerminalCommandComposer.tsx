import type { TranscribeVoiceRequest } from "@runweave/shared";
import { IonButton, IonIcon, IonTextarea } from "@ionic/react";
import {
  arrowUp,
  imageOutline,
  micOutline,
  stop,
  stopCircleOutline,
} from "ionicons/icons";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { recordSupportLog } from "../features/support-logs";
import { startVoiceRecording } from "../lib/voice-recorder";

export function TerminalCommandComposer({
  disabled,
  isPickingImage,
  isStopping,
  onPickImage,
  onSendInput,
  onStop,
  onTranscribeVoice,
}: {
  disabled: boolean;
  isPickingImage: boolean;
  isStopping: boolean;
  onPickImage: (file: File) => Promise<string>;
  onSendInput: (data: string) => Promise<void>;
  onStop: () => void;
  onTranscribeVoice: (payload: TranscribeVoiceRequest) => Promise<string>;
}) {
  const [value, setValue] = useState("");
  const [voiceState, setVoiceState] = useState<
    "idle" | "starting" | "recording" | "transcribing"
  >("idle");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceRecordingRef = useRef<Awaited<
    ReturnType<typeof startVoiceRecording>
  > | null>(null);
  const voiceStartInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const lastActionModeRef = useRef<string | null>(null);

  const handleSubmit = async () => {
    const text = value.trimEnd();
    if (!text) {
      return;
    }
    try {
      await onSendInput(text);
      setValue("");
    } catch {
      // Keep the user's input so failed sends can be retried.
    }
  };

  const handlePickImage = () => {
    fileInputRef.current?.click();
  };

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    void (async () => {
      try {
        const imageInput = await onPickImage(file);
        setValue((current) => {
          if (!current) {
            return imageInput;
          }
          return /\s$/.test(current)
            ? `${current}${imageInput}`
            : `${current} ${imageInput}`;
        });
      } catch {
        // Keep the user's input so failed uploads can be retried.
      }
    })();
  };

  const appendVoiceText = (text: string) => {
    setValue((current) => {
      const nextText = text.trim();
      if (!nextText) {
        return current;
      }
      if (!current) {
        return nextText;
      }
      return /\s$/.test(current)
        ? `${current}${nextText}`
        : `${current} ${nextText}`;
    });
  };

  const handleVoiceClick = () => {
    if (
      disabled ||
      voiceState === "starting" ||
      voiceState === "transcribing" ||
      voiceStartInFlightRef.current
    ) {
      return;
    }

    void (async () => {
      if (voiceState === "recording") {
        const recording = voiceRecordingRef.current;
        voiceRecordingRef.current = null;
        if (isMountedRef.current) {
          setVoiceState("transcribing");
        }
        try {
          const clip = await recording?.stop();
          if (!clip) {
            return;
          }
          const transcript = await onTranscribeVoice(clip);
          if (isMountedRef.current) {
            appendVoiceText(transcript);
          }
        } catch (error) {
          recordSupportLog(
            "terminal.voice.transcribe.failed",
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "warn",
          );
        } finally {
          if (isMountedRef.current) {
            setVoiceState("idle");
          }
        }
        return;
      }

      try {
        voiceStartInFlightRef.current = true;
        setVoiceState("starting");
        const recording = await startVoiceRecording();
        voiceStartInFlightRef.current = false;
        if (!isMountedRef.current) {
          await recording.cancel();
          return;
        }
        voiceRecordingRef.current = recording;
        setVoiceState("recording");
        recordSupportLog("terminal.voice.recording.started");
      } catch (error) {
        recordSupportLog(
          "terminal.voice.recording.failed",
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "warn",
        );
        voiceStartInFlightRef.current = false;
        if (isMountedRef.current) {
          setVoiceState("idle");
        }
      }
    })();
  };

  const hasText = value.trimEnd().length > 0;
  const showStop = isStopping && !hasText;
  const actionDisabled = disabled || (!showStop && !hasText);
  const voiceDisabled =
    disabled || voiceState === "starting" || voiceState === "transcribing";
  const voiceLabel =
    voiceState === "recording"
      ? "Stop voice recording"
      : voiceState === "starting"
        ? "Starting voice recording"
      : voiceState === "transcribing"
        ? "Transcribing voice"
        : "Record voice";

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      voiceStartInFlightRef.current = false;
      const recording = voiceRecordingRef.current;
      voiceRecordingRef.current = null;
      if (recording) {
        void recording.cancel().catch((error: unknown) => {
          recordSupportLog(
            "terminal.voice.recording.cancel_failed",
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "warn",
          );
        });
      }
    };
  }, []);

  useEffect(() => {
    const actionMode = `${showStop ? "stop" : "send"}:${actionDisabled}`;
    if (lastActionModeRef.current === actionMode) {
      return;
    }
    lastActionModeRef.current = actionMode;
    recordSupportLog("terminal.composer.action_mode.changed", {
      disabled,
      isPickingImage,
      isStopping,
      valueLength: value.length,
      trimmedEndLength: value.trimEnd().length,
      showStop,
      actionDisabled,
      actionLabel: showStop ? "Stop terminal command" : "Send command",
    });
  }, [actionDisabled, disabled, isPickingImage, isStopping, showStop, value]);

  return (
    <footer className="terminal-composer">
      <input
        accept="image/*"
        aria-label="Choose image"
        className="terminal-composer__file-input"
        disabled={disabled || isPickingImage}
        onChange={handleImageChange}
        ref={fileInputRef}
        type="file"
      />
      <div className="terminal-composer__input-row">
        <IonButton
          aria-label="Choose image"
          className="terminal-composer__icon-button"
          disabled={disabled || isPickingImage}
          fill="clear"
          onClick={handlePickImage}
          type="button"
        >
          <IonIcon aria-hidden="true" icon={imageOutline} />
        </IonButton>
        <button
          aria-label={voiceLabel}
          className={`terminal-composer__voice-button ${
            voiceState === "recording" ? "is-recording" : ""
          }`}
          disabled={voiceDisabled}
          onClick={handleVoiceClick}
          type="button"
        >
          <IonIcon
            aria-hidden="true"
            icon={voiceState === "recording" ? stopCircleOutline : micOutline}
          />
        </button>
        <IonTextarea
          autoGrow
          className="terminal-composer__input"
          disabled={disabled}
          onIonInput={(event) => setValue(String(event.detail.value ?? ""))}
          placeholder="Type a command..."
          rows={1}
          value={value}
        />
        <IonButton
          aria-label={showStop ? "Stop terminal command" : "Send command"}
          className={`terminal-composer__action ${showStop ? "is-stop" : "is-send"}`}
          disabled={actionDisabled}
          fill={showStop ? "outline" : "solid"}
          onClick={showStop ? onStop : handleSubmit}
          type="button"
        >
          <IonIcon aria-hidden="true" icon={showStop ? stop : arrowUp} />
        </IonButton>
      </div>
    </footer>
  );
}
