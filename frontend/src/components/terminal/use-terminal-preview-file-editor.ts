import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalPreviewFileResponse } from "@runweave/shared/terminal/preview";
import { HttpError } from "../../services/http";
import { saveTerminalProjectPreviewFile } from "../../services/terminal-preview";

interface LoadedFileState {
  editorContent: string;
  loadedContent: string;
  loadedMtimeMs?: number;
  path: string | null;
}

const EMPTY_FILE_STATE: LoadedFileState = {
  editorContent: "",
  loadedContent: "",
  path: null,
};

export function useTerminalPreviewFileEditor(input: {
  apiBase: string;
  token: string;
  projectId: string | null;
  selectedFilePath?: string;
  filePreview: TerminalPreviewFileResponse | null;
  editable: boolean;
  onAuthExpired?: () => void;
  onFileSaved: (file: TerminalPreviewFileResponse) => void;
}) {
  const [loadedFile, setLoadedFile] =
    useState<LoadedFileState>(EMPTY_FILE_STATE);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!input.selectedFilePath) {
      setLoadedFile(EMPTY_FILE_STATE);
      return;
    }
    if (
      !input.filePreview ||
      input.filePreview.path !== input.selectedFilePath
    ) {
      setLoadedFile({
        editorContent: "",
        loadedContent: "",
        path: input.selectedFilePath,
      });
      return;
    }
    setLoadedFile({
      editorContent: input.filePreview.content,
      loadedContent: input.filePreview.content,
      loadedMtimeMs: input.filePreview.mtimeMs,
      path: input.filePreview.path,
    });
    setSaveError(null);
    setSaveConflict(false);
    setLastSavedAt(null);
  }, [input.filePreview, input.selectedFilePath]);

  const isDirty =
    input.editable && loadedFile.editorContent !== loadedFile.loadedContent;

  const setEditorContent = useMemoizedFn((content: string) => {
    setLoadedFile((current) => ({ ...current, editorContent: content }));
    setSaveError(null);
    setSaveConflict(false);
  });

  const replaceLoadedFile = useMemoizedFn(
    (file: TerminalPreviewFileResponse) => {
      setLoadedFile({
        editorContent: file.content,
        loadedContent: file.content,
        loadedMtimeMs: file.mtimeMs,
        path: file.path,
      });
      setSaveError(null);
      setSaveConflict(false);
      setLastSavedAt(null);
    },
  );

  const clearEditor = useMemoizedFn(() => {
    setLoadedFile(EMPTY_FILE_STATE);
    setSaveError(null);
    setSaveConflict(false);
    setLastSavedAt(null);
  });

  const saveFile = useMemoizedFn(
    async (options?: { overwrite?: boolean }): Promise<void> => {
      if (
        !input.projectId ||
        !input.filePreview ||
        !input.editable ||
        savePending ||
        loadedFile.loadedMtimeMs === undefined
      ) {
        return;
      }
      setSavePending(true);
      setSaveError(null);
      setSaveConflict(false);
      try {
        const payload = await saveTerminalProjectPreviewFile(
          input.apiBase,
          input.token,
          input.projectId,
          {
            path: input.filePreview.path,
            content: loadedFile.editorContent,
            expectedMtimeMs: loadedFile.loadedMtimeMs,
            overwrite: options?.overwrite,
          },
        );
        input.onFileSaved(payload);
        setLoadedFile({
          editorContent: payload.content,
          loadedContent: payload.content,
          loadedMtimeMs: payload.mtimeMs,
          path: payload.path,
        });
        setLastSavedAt(Date.now());
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          input.onAuthExpired?.();
        }
        if (error instanceof HttpError && error.status === 409) {
          setSaveConflict(true);
        }
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        setSavePending(false);
      }
    },
  );

  return {
    editorContent: loadedFile.editorContent,
    loadedMtimeMs: loadedFile.loadedMtimeMs,
    savePending,
    saveError,
    saveConflict,
    lastSavedAt,
    isDirty,
    setEditorContent,
    replaceLoadedFile,
    clearEditor,
    saveFile,
  };
}
