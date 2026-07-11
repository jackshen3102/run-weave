import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { TerminalMobileKeybar } from "./terminal-mobile-keybar";

interface TerminalMobileControlsProps {
  active: boolean;
  open: boolean;
  terminalRef: RefObject<Terminal | null>;
  onOpenChange: (open: boolean) => void;
  onSendInput: (data: string) => void;
}

export function TerminalMobileControls({
  active,
  open,
  terminalRef,
  onOpenChange,
  onSendInput,
}: TerminalMobileControlsProps) {
  if (!active) {
    return null;
  }
  return (
    <>
      <div className="pointer-events-none absolute top-3 right-4 z-30">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Toggle terminal shortcut keys"
          className="pointer-events-auto rounded-md border border-slate-700 bg-slate-950/90 px-2 py-1 text-[10px] leading-none text-slate-300 backdrop-blur active:bg-slate-800"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onOpenChange(!open);
            requestAnimationFrame(() => terminalRef.current?.focus());
          }}
        >
          Keys
        </button>
      </div>
      <TerminalMobileKeybar visible={open} onSendInput={onSendInput} />
    </>
  );
}
