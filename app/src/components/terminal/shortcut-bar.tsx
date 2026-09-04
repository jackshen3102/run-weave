const SHORTCUTS = [
  { label: "Ctrl-C", data: "\x03" },
  { label: "Tab", data: "\t" },
  { label: "Esc", data: "\x1b" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "Enter", data: "\r" },
];

export function TerminalShortcutBar({
  disabled = false,
  onSendInput,
}: {
  disabled?: boolean;
  onSendInput: (data: string) => void;
}) {
  return (
    <div className="terminal-shortcut-bar" aria-label="Terminal shortcuts">
      {SHORTCUTS.map((shortcut) => (
        <button
          className="terminal-shortcut-bar__button"
          disabled={disabled}
          key={shortcut.label}
          onClick={() => onSendInput(shortcut.data)}
          type="button"
        >
          {shortcut.label}
        </button>
      ))}
    </div>
  );
}
