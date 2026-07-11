import type { ReactNode, RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { PastedImageReference } from "./terminal-surface-utils";
import { TerminalPaneResizeOverlay } from "./terminal-pane-resize-overlay";

interface TerminalSurfaceLayoutProps {
  active: boolean;
  controls: ReactNode;
  error: string | null;
  mobileControls: ReactNode;
  paneWorkspace: TerminalPanelWorkspace | null;
  pastedImages: PastedImageReference[];
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
  mobileControls,
  paneWorkspace,
  pastedImages,
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
      {pastedImages.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {pastedImages.map((image) => (
            <span
              className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 font-mono text-xs text-slate-200"
              key={image.id}
              title={image.filePath}
            >
              {image.label}
            </span>
          ))}
        </div>
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
