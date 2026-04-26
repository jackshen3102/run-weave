import { type PointerEvent as ReactPointerEvent } from "react";
import type {
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalSvgViewMode,
} from "../../features/terminal/preview-store";

interface UpdateProjectPreview {
  (
    projectId: string,
    patch: Record<string, string | number | undefined>,
  ): void;
}

interface TerminalPreviewPanelActionsArgs {
  expanded: boolean;
  mode: string | null;
  projectId: string | null;
  query: string;
  selectedFilePath?: string;
  selectedPath: string | null;
  loadFile: (filePath: string) => Promise<void>;
  loadChanges: () => Promise<void>;
  setWidth: (width: number) => void;
  updateProjectPreview: UpdateProjectPreview;
  setFilePreview: (value: null) => void;
  setFileError: (value: string | null) => void;
  setMarkdownScrollRatio: (value: number) => void;
}

export function useTerminalPreviewPanelActions({
  expanded,
  mode,
  projectId,
  query,
  selectedFilePath,
  selectedPath,
  loadFile,
  loadChanges,
  setWidth,
  updateProjectPreview,
  setFilePreview,
  setFileError,
  setMarkdownScrollRatio,
}: TerminalPreviewPanelActionsArgs) {
  const refresh = (): void => {
    if (mode === "file") {
      if (selectedFilePath) {
        void loadFile(selectedFilePath);
      } else if (projectId) {
        updateProjectPreview(projectId, { openFileQuery: query });
      }
      return;
    }
    if (mode === "changes") {
      void loadChanges();
    }
  };

  const copyPath = (): void => {
    if (!selectedPath) {
      return;
    }
    void navigator.clipboard?.writeText(selectedPath);
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
    if (!projectId) {
      return;
    }
    updateProjectPreview(projectId, {
      mode: "file",
      selectedFilePath: filePath,
      path: filePath,
    });
    setFilePreview(null);
    setFileError(null);
    setMarkdownScrollRatio(0);
  };

  const setMarkdownViewMode = (nextMode: TerminalMarkdownViewMode): void => {
    if (projectId) {
      updateProjectPreview(projectId, { markdownViewMode: nextMode });
    }
  };

  const setSvgViewMode = (nextMode: TerminalSvgViewMode): void => {
    if (projectId) {
      updateProjectPreview(projectId, { svgViewMode: nextMode });
    }
  };

  const setChangesViewMode = (nextMode: TerminalChangesViewMode): void => {
    if (projectId) {
      updateProjectPreview(projectId, { changesViewMode: nextMode });
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
      updateProjectPreview(projectId, {
        markdownSplitSourceWidthPct: Math.round(nextPct),
      });
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stop);
  };

  return {
    copyPath,
    openFilePath,
    refresh,
    setChangesViewMode,
    setMarkdownViewMode,
    setSvgViewMode,
    startMarkdownResize,
    startResize,
  };
}
