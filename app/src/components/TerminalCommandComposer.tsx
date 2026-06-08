import { IonButton, IonIcon, IonTextarea } from "@ionic/react";
import { arrowUp, imageOutline, stop } from "ionicons/icons";
import type { ChangeEvent } from "react";
import { useRef, useState } from "react";

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
  onPickImage: (file: File) => void;
  onSendInput: (data: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = () => {
    const text = value.trimEnd();
    if (!text) {
      return;
    }
    onSendInput(`${text}\n`);
    setValue("");
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
    onPickImage(file);
  };

  const hasText = value.trimEnd().length > 0;
  const showStop = isStopping && !hasText;
  const actionDisabled = disabled || (!showStop && !hasText);

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
