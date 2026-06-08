import { IonButton } from "@ionic/react";

const SHORTCUTS = [
  { label: "Ctrl-C", data: "\x03" },
  { label: "Tab", data: "\t" },
  { label: "Esc", data: "\x1b" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
];

export function TerminalShortcutBar({
  onSendInput,
}: {
  onSendInput: (data: string) => void;
}) {
  return (
    <div className="terminal-shortcut-bar" aria-label="Terminal shortcuts">
      {SHORTCUTS.map((shortcut) => (
        <IonButton
          fill="clear"
          key={shortcut.label}
          onClick={() => onSendInput(shortcut.data)}
          type="button"
        >
          {shortcut.label}
        </IonButton>
      ))}
    </div>
  );
}
