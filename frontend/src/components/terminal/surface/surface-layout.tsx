import type { ReactNode, RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import { TerminalPaneResizeOverlay } from "../input/pane-resize-overlay";

interface TerminalSurfaceLayoutProps {
  active: boolean;
  controls: ReactNode;
  error: string | null;
  notice: string | null;
  mobileControls: ReactNode;
  paneWorkspace: TerminalPanelWorkspace | null;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  toolbar: ReactNode;
  onResizePane?: (
    panelId: string,
    direction: "left" | "right" | "up" | "down",
    cells: number,
  ) => void;
}

export function TerminalSurfaceLayout({
  active,
  controls,
  error,
  notice,
  mobileControls,
  paneWorkspace,
  terminalContainerRef,
  terminalRef,
  toolbar,
  onResizePane,
}: TerminalSurfaceLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <p className="px-3 py-2 text-xs text-rose-400">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="px-3 py-2 text-xs text-amber-300">
          {notice}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {toolbar}
        {mobileControls}
        <div
          aria-label="Terminal emulator"
          className="h-full min-h-full w-full bg-[#0b1220] pl-2 pt-1.5 pb-1.5"
          role="application"
          tabIndex={0}
          onClick={() => {
            if (active) terminalRef.current?.focus();
          }}
          onFocus={() => {
            if (active) terminalRef.current?.focus();
          }}
          ref={terminalContainerRef}
        />
        {onResizePane ? (
          <TerminalPaneResizeOverlay
            workspace={paneWorkspace}
            terminalRef={terminalRef}
            onResize={onResizePane}
          />
        ) : null}
        {controls}
      </div>
    </div>
  );
}
