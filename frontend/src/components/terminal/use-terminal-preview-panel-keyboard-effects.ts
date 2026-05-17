import { useEffect, type MutableRefObject } from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewGitChangesResponse,
} from "@browser-viewer/shared";

export function resolveSelectedPreviewChange(params: {
  changes: TerminalPreviewGitChangesResponse;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
}): { path: string; kind: TerminalPreviewChangeKind } | null {
  const { changes, selectedChangeKind, selectedChangePath } = params;
  if (selectedChangePath && selectedChangeKind) {
    const candidates =
      selectedChangeKind === "staged" ? changes.staged : changes.working;
    if (candidates.some((file) => file.path === selectedChangePath)) {
      return {
        path: selectedChangePath,
        kind: selectedChangeKind,
      };
    }
  }

  if (changes.staged[0]) {
    return {
      path: changes.staged[0].path,
      kind: "staged",
    };
  }

  if (changes.working[0]) {
    return {
      path: changes.working[0].path,
      kind: "working",
    };
  }

  return null;
}

export function useTerminalPreviewPanelKeyboardEffects({
  expanded,
  setExpanded,
  isFileEditable,
  saveFile,
  isDirty,
  pathCopiedTimeoutRef,
}: {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  isFileEditable: boolean;
  saveFile: () => void;
  isDirty: boolean;
  pathCopiedTimeoutRef: MutableRefObject<number | null>;
}) {
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded, setExpanded]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (!isFileEditable) {
          return;
        }
        event.preventDefault();
        saveFile();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFileEditable, saveFile]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!isDirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty]);

  useEffect(() => {
    const timeoutRef = pathCopiedTimeoutRef;
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, [pathCopiedTimeoutRef]);
}
