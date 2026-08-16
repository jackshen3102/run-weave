interface TerminalMobileKeybarProps {
  visible: boolean;
  onSendInput: (input: string) => void;
}

interface ShortcutButton {
  label: string;
  sequence: string;
  title: string;
}

const SHORTCUT_BUTTONS: ShortcutButton[] = [
  { label: "↑", sequence: "\u001b[A", title: "Up Arrow" },
  { label: "↓", sequence: "\u001b[B", title: "Down Arrow" },
  { label: "Tab", sequence: "\t", title: "Tab" },
  { label: "Esc", sequence: "\u001b", title: "Escape" },
  { label: "Ctrl-C", sequence: "\u0003", title: "Ctrl-C (Interrupt)" },
];

export function TerminalMobileKeybar({
  visible,
  onSendInput,
}: TerminalMobileKeybarProps) {
  if (!visible) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto absolute top-3 right-20 left-2 z-20 flex items-center gap-1 overflow-x-auto rounded-md border border-slate-700 bg-slate-950/95 p-1 shadow-[0_12px_28px_-24px_rgba(15,23,42,0.95)] backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="toolbar"
      aria-label="Terminal shortcut keys"
    >
      {SHORTCUT_BUTTONS.map((button) => (
        <button
          key={button.label}
          type="button"
          title={button.title}
          className="h-6 min-w-7 shrink-0 rounded border border-slate-600 bg-slate-800 px-1.5 py-0 font-mono text-[10px] font-medium leading-none text-slate-100 active:bg-slate-700"
          onPointerDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onSendInput(button.sequence);
          }}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}
