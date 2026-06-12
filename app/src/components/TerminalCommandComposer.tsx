import { IonButton, IonIcon, IonTextarea } from "@ionic/react";
import { arrowUp, imageOutline, stop } from "ionicons/icons";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { recordSupportLog } from "../features/support-logs";

export function TerminalCommandComposer({
  disabled,
  isPickingImage,
  isStopping,
  onPickImage,
  onSendInput,
  onStop,
}: {
  disabled: boolean;
  isPickingImage: boolean;
  isStopping: boolean;
  onPickImage: (file: File) => Promise<string>;
  onSendInput: (data: string) => Promise<void>;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  const hasText = value.trimEnd().length > 0;
  const showStop = isStopping && !hasText;
  const actionDisabled = disabled || (!showStop && !hasText);

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
  }, [
    actionDisabled,
    disabled,
    isPickingImage,
    isStopping,
    showStop,
    value,
  ]);

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
