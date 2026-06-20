import { type PointerEvent as ReactPointerEvent } from "react";
import type {
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalPreviewMode,
  TerminalSvgViewMode,
} from "../../features/terminal/preview-store";

interface TerminalPreviewPanelActionsArgs {
  expanded: boolean;
  mode: string | null;
  projectId: string | null;
  query: string;
  selectedFilePath?: string;
  copyPath: string | null;
  loadFile: (filePath: string) => Promise<void>;
  loadChanges: () => Promise<void>;
  setWidth: (width: number) => void;
  setOpenFileQuery: (projectId: string, query: string) => void;
  openFile: (
    projectId: string,
    filePath: string,
    mode?: Extract<TerminalPreviewMode, "file" | "explorer">,
  ) => void;
  setMarkdownViewModeInStore: (
    projectId: string,
    mode: TerminalMarkdownViewMode,
  ) => void;
  setMarkdownSplitSourceWidthPct: (
    projectId: string,
    widthPct: number,
  ) => void;
  setSvgViewModeInStore: (projectId: string, mode: TerminalSvgViewMode) => void;
  setChangesViewModeInStore: (
    projectId: string,
    mode: TerminalChangesViewMode,
  ) => void;
  setFilePreview: (value: null) => void;
  setFileError: (value: string | null) => void;
  setMarkdownScrollRatio: (value: number) => void;
  confirmDiscardDraft: () => boolean;
}

export function useTerminalPreviewPanelActions({
  expanded,
  mode,
  projectId,
  query,
  selectedFilePath,
  copyPath,
  loadFile,
  loadChanges,
  setWidth,
  setOpenFileQuery,
  openFile,
  setMarkdownViewModeInStore,
  setMarkdownSplitSourceWidthPct,
  setSvgViewModeInStore,
  setChangesViewModeInStore,
  setFilePreview,
  setFileError,
  setMarkdownScrollRatio,
  confirmDiscardDraft,
}: TerminalPreviewPanelActionsArgs) {
  const refresh = (): void => {
    if (!confirmDiscardDraft()) {
      return;
    }
    if (mode === "file" || mode === "explorer") {
      if (selectedFilePath) {
        void loadFile(selectedFilePath);
      } else if (projectId) {
        setOpenFileQuery(projectId, query);
      }
      return;
    }
    if (mode === "changes") {
      void loadChanges();
    }
  };

  const copySelectedPath = async (): Promise<boolean> => {
    if (!copyPath || !navigator.clipboard) {
      return false;
    }
    await navigator.clipboard.writeText(copyPath);
    return true;
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (expanded) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handlePointerMove = (moveEvent: globalThis.PointerEvent): void => {
      const nextWidth = Math.min(
        Math.round(window.innerWidth * 0.6),
        Math.max(320, window.innerWidth - moveEvent.clientX),
      );
      setWidth(nextWidth);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const openFilePath = (filePath: string): void => {
    if (!projectId || !confirmDiscardDraft()) {
      return;
    }
    const targetMode = mode === "explorer" ? "explorer" : "file";
    openFile(projectId, filePath, targetMode);
    setFilePreview(null);
    setFileError(null);
    setMarkdownScrollRatio(0);
  };

  const setMarkdownViewMode = (nextMode: TerminalMarkdownViewMode): void => {
    if (projectId) {
      setMarkdownViewModeInStore(projectId, nextMode);
    }
  };

  const setSvgViewMode = (nextMode: TerminalSvgViewMode): void => {
    if (projectId) {
      setSvgViewModeInStore(projectId, nextMode);
    }
  };

  const setChangesViewMode = (nextMode: TerminalChangesViewMode): void => {
    if (projectId) {
      setChangesViewModeInStore(projectId, nextMode);
    }
  };

  const startMarkdownResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (!projectId) {
      return;
    }
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    const handlePointerMove = (moveEvent: globalThis.PointerEvent): void => {
      const rect = container?.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        return;
      }
      const nextPct = Math.min(
        70,
        Math.max(30, ((moveEvent.clientX - rect.left) / rect.width) * 100),
      );
      setMarkdownSplitSourceWidthPct(projectId, Math.round(nextPct));
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stop);
  };

  return {
    copyPath: copySelectedPath,
    openFilePath,
    refresh,
    setChangesViewMode,
    setMarkdownViewMode,
    setSvgViewMode,
    startMarkdownResize,
    startResize,
  };
}
