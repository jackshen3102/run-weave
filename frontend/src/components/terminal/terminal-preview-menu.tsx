import { useRef, useState } from "react";
import type { TerminalPreviewMode } from "../../features/terminal/preview-store";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";

interface TerminalPreviewMenuProps {
  projectId: string | null;
  mode: TerminalPreviewMode | null;
  disabled?: boolean;
}

export function TerminalPreviewMenu({
  projectId,
  mode,
  disabled = false,
}: TerminalPreviewMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const openPreview = useTerminalPreviewStore((state) => state.openPreview);
  const closePreview = useTerminalPreviewStore((state) => state.closePreview);
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);

  const label =
    previewOpen && mode
      ? mode === "changes"
        ? "Preview: Changes"
        : "Preview: File"
      : "Preview";
  const itemClassName =
    "flex w-full cursor-default select-none items-center rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted focus:bg-muted";

  const cancelClose = (): void => {
    if (closeTimerRef.current === null) {
      return;
    }
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openMenu = (): void => {
    if (disabled || !projectId) {
      return;
    }
    cancelClose();
    setMenuOpen(true);
  };

  const scheduleClose = (): void => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setMenuOpen(false);
      closeTimerRef.current = null;
    }, 120);
  };

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={previewOpen ? "secondary" : "ghost"}
          disabled={disabled || !projectId}
          className="h-9 shrink-0 rounded-full px-4"
          onMouseEnter={openMenu}
          onMouseLeave={scheduleClose}
          onFocus={openMenu}
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <button
          type="button"
          className={itemClassName}
          onClick={() => {
            if (projectId) {
              openPreview(projectId, "file");
            }
            setMenuOpen(false);
          }}
        >
          Open file...
        </button>
        <button
          type="button"
          className={itemClassName}
          onClick={() => {
            if (projectId) {
              openPreview(projectId, "changes");
            }
            setMenuOpen(false);
          }}
        >
          Changes
        </button>
        {previewOpen ? (
          <>
            <div className="-mx-1 my-1 h-px bg-border/60" />
            <button
              type="button"
              className={itemClassName}
              onClick={() => {
                closePreview();
                setMenuOpen(false);
              }}
            >
              Close preview
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
