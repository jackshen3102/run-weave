import { IonButton, IonTextarea } from "@ionic/react";
import { useState } from "react";

export function TerminalCommandComposer({
  disabled,
  onSendInput,
}: {
  disabled: boolean;
  onSendInput: (data: string) => void;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    const text = value.trimEnd();
    if (!text) {
      return;
    }
    onSendInput(`${text}\n`);
    setValue("");
  };

  return (
    <footer className="terminal-composer">
      <div className="terminal-composer__input-row">
        <IonTextarea
          autoGrow
          className="terminal-composer__input"
          disabled={disabled}
          onIonInput={(event) => setValue(String(event.detail.value ?? ""))}
          placeholder="Command"
          rows={1}
          value={value}
        />
        <IonButton
          className="terminal-composer__send"
          disabled={disabled || value.trimEnd().length === 0}
          onClick={handleSubmit}
          type="button"
        >
          Send
        </IonButton>
      </div>
    </footer>
  );
}
