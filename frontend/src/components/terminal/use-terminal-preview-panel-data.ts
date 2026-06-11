import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import { createTerminalPreviewRequestSequencer } from "@browser-viewer/shared";
import {
  useTerminalPreviewStore,
  DEFAULT_MARKDOWN_VIEW_MODE,
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
} from "../../features/terminal/preview-store";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
} from "../../features/terminal/preview-file-types";
import { HttpError } from "../../services/http";
import {
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  saveTerminalProjectPreviewFile,
  searchTerminalProjectPreviewFiles,
} from "../../services/terminal";
import {
  resolveSelectedPreviewChange,
  useTerminalPreviewPanelKeyboardEffects,
} from "./use-terminal-preview-panel-keyboard-effects";
import {
  getSelectedTerminalPreviewPath,
  getTerminalPreviewCopyPath,
} from "./terminal-preview-panel-paths";

interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

interface UseTerminalPreviewPanelDataArgs {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  widthPx?: number;
  onAuthExpired?: () => void;
}

export function useTerminalPreviewPanelData({
  apiBase,
  token,
  activeProject,
  widthPx,
  onAuthExpired,
}: UseTerminalPreviewPanelDataArgs) {
  const closePreview = useTerminalPreviewStore((state) => state.closePreview);
  const setWidth = useTerminalPreviewStore((state) => state.setWidth);
  const expanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const activeTool = useTerminalPreviewStore((state) => state.ui.activeTool);
  const setActiveTool = useTerminalPreviewStore((state) => state.setActiveTool);
  const setExpanded = useTerminalPreviewStore((state) => state.setExpanded);
  const updateProjectPreview = useTerminalPreviewStore(
    (state) => state.updateProjectPreview,
  );
  const projectState = useTerminalPreviewStore((state) =>
    activeProject ? state.projects[activeProject.projectId] : undefined,
  );
  const mode = projectState?.mode ?? null;
  const query = projectState?.openFileQuery ?? "";
  const selectedFilePath = projectState?.selectedFilePath;
  const selectedChangePath = projectState?.selectedChangePath;
  const selectedChangeKind = projectState?.selectedChangeKind;
  const markdownViewMode =
    projectState?.markdownViewMode ?? DEFAULT_MARKDOWN_VIEW_MODE;
  const markdownSplitSourceWidthPct =
    projectState?.markdownSplitSourceWidthPct ?? 50;
  const svgViewMode = projectState?.svgViewMode ?? "preview";
  const changesViewMode = projectState?.changesViewMode ?? "diff";
  const [searchItems, setSearchItems] = useState<
    TerminalPreviewFileSearchItem[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filePreview, setFilePreview] =
    useState<TerminalPreviewFileResponse | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [loadedContent, setLoadedContent] = useState("");
  const [loadedMtimeMs, setLoadedMtimeMs] = useState<number | undefined>(
    undefined,
  );
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [changes, setChanges] =
    useState<TerminalPreviewGitChangesResponse | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [fileDiff, setFileDiff] =
    useState<TerminalPreviewFileDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const fileRequestSequencer = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const changesRequestSequencer = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const diffRequestSequencer = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const selectedChangePathRef = useRef(selectedChangePath);
  const selectedChangeKindRef = useRef(selectedChangeKind);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [markdownScrollRatio, setMarkdownScrollRatio] = useState(0);
  const [pathCopied, setPathCopied] = useState(false);
  const pathCopiedTimeoutRef = useRef<number | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<PreviewFileMutationTarget | null>(null);
  const [renameTarget, setRenameTarget] =
    useState<PreviewFileMutationTarget | null>(null);
  const [renamePath, setRenamePath] = useState("");
  const [mutationPending, setMutationPending] = useState<
    "delete" | "rename" | null
  >(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const projectId = activeProject?.projectId ?? null;
  const hasProjectPath = Boolean(activeProject?.path);
  const absoluteInput = query.trim().startsWith("/");
  const panelWidth = expanded
    ? "100%"
    : widthPx
      ? `${widthPx}px`
      : DEFAULT_TERMINAL_SIDECAR_WIDTH;
  const fileKind = selectedFilePath
    ? getTerminalPreviewFileKind(selectedFilePath, filePreview?.language)
    : "text";
  const isFileEditable =
    (mode === "file" || mode === "explorer") &&
    Boolean(filePreview) &&
    filePreview?.readonly === false &&
    fileKind !== "image";
  const isDirty = isFileEditable && editorContent !== loadedContent;

  const confirmDiscardDraft = useCallback((): boolean => {
    if (!isDirty) {
      return true;
    }
    return window.confirm("Discard unsaved Preview changes?");
  }, [isDirty]);

  const handleRequestError = useCallback(
    (error: unknown): string => {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
      }
      return error instanceof Error ? error.message : String(error);
    },
    [onAuthExpired],
  );

  const loadFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (!projectId) {
        return;
      }
      const requestId = fileRequestSequencer.next();
      setFileLoading(true);
      setFileError(null);
      setFilePreview(null);
      try {
        const payload = await getTerminalProjectPreviewFile(
          apiBase,
          token,
          projectId,
          filePath,
        );
        if (!fileRequestSequencer.isCurrent(requestId)) {
          return;
        }
        setFilePreview(payload);
        setEditorContent(payload.content);
        setLoadedContent(payload.content);
        setLoadedMtimeMs(payload.mtimeMs);
        setSaveError(null);
        setSaveConflict(false);
        setLastSavedAt(null);
      } catch (error) {
        if (!fileRequestSequencer.isCurrent(requestId)) {
          return;
        }
        setFilePreview(null);
        setFileError(handleRequestError(error));
      } finally {
        if (fileRequestSequencer.isCurrent(requestId)) {
          setFileLoading(false);
        }
      }
    },
    [apiBase, fileRequestSequencer, handleRequestError, projectId, token],
  );

  const loadDiff = useCallback(
    async (
      filePath: string,
      kind: TerminalPreviewChangeKind,
    ): Promise<void> => {
      if (!projectId) {
        return;
      }
      const requestId = diffRequestSequencer.next();
      setDiffLoading(true);
      setDiffError(null);
      try {
        const payload = await getTerminalProjectPreviewFileDiff(
          apiBase,
          token,
          projectId,
          { path: filePath, kind },
        );
        if (!diffRequestSequencer.isCurrent(requestId)) {
          return;
        }
        setFileDiff(payload);
      } catch (error) {
        if (!diffRequestSequencer.isCurrent(requestId)) {
          return;
        }
        setFileDiff(null);
        setDiffError(handleRequestError(error));
      } finally {
        if (diffRequestSequencer.isCurrent(requestId)) {
          setDiffLoading(false);
        }
      }
    },
    [apiBase, diffRequestSequencer, handleRequestError, projectId, token],
  );

  const loadChanges = useCallback(
    async (options?: {
      reloadDiff?: boolean;
      preserveMode?: boolean;
    }): Promise<void> => {
      if (!projectId) {
        return;
      }
      const reloadDiff = options?.reloadDiff ?? true;
      const preserveMode = options?.preserveMode ?? false;
      const requestId = changesRequestSequencer.next();
      setChangesLoading(true);
      setChangesError(null);
      try {
        const payload = await getTerminalProjectPreviewGitChanges(
          apiBase,
          token,
          projectId,
        );
        if (!changesRequestSequencer.isCurrent(requestId)) {
          return;
        }
        setChanges(payload);
        const selected = resolveSelectedPreviewChange({
          changes: payload,
          selectedChangePath: selectedChangePathRef.current,
          selectedChangeKind: selectedChangeKindRef.current,
        });
        if (!selected) {
          diffRequestSequencer.invalidate();
          setFileDiff(null);
          setDiffError(null);
          setDiffLoading(false);
          if (!preserveMode) {
            updateProjectPreview(projectId, {
              mode: "changes",
              selectedChangePath: undefined,
              selectedChangeKind: undefined,
            });
          }
          return;
        }

        const selectedChanged =
          selected.path !== selectedChangePathRef.current ||
          selected.kind !== selectedChangeKindRef.current;
        if (selectedChanged) {
          if (!preserveMode) {
            updateProjectPreview(projectId, {
              mode: "changes",
              selectedChangePath: selected.path,
              selectedChangeKind: selected.kind,
            });
          }
          return;
        }
        if (reloadDiff && !preserveMode) {
          void loadDiff(selected.path, selected.kind);
        }
      } catch (error) {
        if (!changesRequestSequencer.isCurrent(requestId)) {
          return;
        }
        setChangesError(handleRequestError(error));
      } finally {
        if (changesRequestSequencer.isCurrent(requestId)) {
          setChangesLoading(false);
        }
      }
    },
    [
      apiBase,
      changesRequestSequencer,
      diffRequestSequencer,
      handleRequestError,
      loadDiff,
      projectId,
      token,
      updateProjectPreview,
    ],
  );

  useEffect(() => {
    fileRequestSequencer.invalidate();
    changesRequestSequencer.invalidate();
    diffRequestSequencer.invalidate();
    setSearchItems([]);
    setSearchError(null);
    setFilePreview(null);
    setEditorContent("");
    setLoadedContent("");
    setLoadedMtimeMs(undefined);
    setSaveLoading(false);
    setSaveError(null);
    setSaveConflict(false);
    setLastSavedAt(null);
    setFileError(null);
    setChanges(null);
    setChangesError(null);
    setFileDiff(null);
    setDiffError(null);
  }, [
    changesRequestSequencer,
    diffRequestSequencer,
    fileRequestSequencer,
    projectId,
  ]);

  useEffect(() => {
    selectedChangePathRef.current = selectedChangePath;
    selectedChangeKindRef.current = selectedChangeKind;
  }, [selectedChangeKind, selectedChangePath]);

  useEffect(() => {
    if (!projectId || !hasProjectPath || mode) {
      return;
    }
    updateProjectPreview(projectId, { mode: "changes" });
  }, [hasProjectPath, mode, projectId, updateProjectPreview]);

  useEffect(() => {
    if ((mode !== "file" && mode !== "explorer") || !selectedFilePath) {
      return;
    }
    if (isSupportedTerminalImagePreviewPath(selectedFilePath)) {
      fileRequestSequencer.invalidate();
      setFilePreview(null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    void loadFile(selectedFilePath);
  }, [fileRequestSequencer, loadFile, mode, selectedFilePath]);

  useEffect(() => {
    if (mode !== "changes" || !hasProjectPath || !projectId) {
      return;
    }
    void loadChanges({
      reloadDiff:
        !selectedChangePathRef.current || !selectedChangeKindRef.current,
    });
  }, [hasProjectPath, loadChanges, mode, projectId]);

  useEffect(() => {
    if (mode !== "changes" || !selectedChangePath || !selectedChangeKind) {
      return;
    }
    void loadDiff(selectedChangePath, selectedChangeKind);
  }, [loadDiff, mode, selectedChangeKind, selectedChangePath]);

  useEffect(() => {
    if (mode !== "file" || !projectId || absoluteInput) {
      setSearchItems([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    setSearchItems([]);
    const timeoutId = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      searchTerminalProjectPreviewFiles(apiBase, token, projectId, {
        query,
        limit: 50,
      })
        .then((payload) => {
          if (!abort.signal.aborted) {
            setSearchItems(payload.items);
          }
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) {
            setSearchError(handleRequestError(error));
          }
        })
        .finally(() => {
          if (!abort.signal.aborted) {
            setSearchLoading(false);
          }
        });
    }, 250);

    return () => {
      abort.abort();
      window.clearTimeout(timeoutId);
    };
  }, [
    absoluteInput,
    apiBase,
    handleRequestError,
    mode,
    projectId,
    query,
    token,
  ]);

  const saveFile = useCallback(
    async (options?: { overwrite?: boolean }): Promise<void> => {
      if (
        !projectId ||
        !filePreview ||
        !isFileEditable ||
        saveLoading ||
        loadedMtimeMs === undefined
      ) {
        return;
      }
      setSaveLoading(true);
      setSaveError(null);
      setSaveConflict(false);
      try {
        const payload = await saveTerminalProjectPreviewFile(
          apiBase,
          token,
          projectId,
          {
            path: filePreview.path,
            content: editorContent,
            expectedMtimeMs: loadedMtimeMs,
            overwrite: options?.overwrite,
          },
        );
        setFilePreview(payload);
        setEditorContent(payload.content);
        setLoadedContent(payload.content);
        setLoadedMtimeMs(payload.mtimeMs);
        setLastSavedAt(Date.now());
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          setSaveConflict(true);
        }
        setSaveError(handleRequestError(error));
      } finally {
        setSaveLoading(false);
      }
    },
    [
      apiBase,
      editorContent,
      filePreview,
      handleRequestError,
      isFileEditable,
      loadedMtimeMs,
      projectId,
      saveLoading,
      token,
    ],
  );

  useTerminalPreviewPanelKeyboardEffects({
    expanded,
    setExpanded,
    isFileEditable,
    saveFile: () => void saveFile(),
    isDirty,
    pathCopiedTimeoutRef,
  });

  const selectedPath = useMemo(
    () =>
      getSelectedTerminalPreviewPath({
        mode,
        selectedFilePath,
        selectedChangePath,
        filePreview,
        fileDiff,
      }),
    [fileDiff, filePreview, mode, selectedChangePath, selectedFilePath],
  );

  const copyPath = useMemo(
    () =>
      getTerminalPreviewCopyPath({
        mode,
        selectedPath,
        filePreview,
        fileDiff,
        activeProject,
      }),
    [activeProject, fileDiff, filePreview, mode, selectedPath],
  );

  useEffect(() => {
    setPathCopied(false);
  }, [copyPath]);

  const refreshFileSearch = useCallback(async (): Promise<void> => {
    if (!projectId || absoluteInput) {
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const payload = await searchTerminalProjectPreviewFiles(
        apiBase,
        token,
        projectId,
        {
          query,
          limit: 50,
        },
      );
      setSearchItems(payload.items);
    } catch (error) {
      setSearchError(handleRequestError(error));
    } finally {
      setSearchLoading(false);
    }
  }, [absoluteInput, apiBase, handleRequestError, projectId, query, token]);



  return {
    closePreview, setWidth, expanded, activeTool, setActiveTool, setExpanded,
    updateProjectPreview, mode, query, selectedFilePath, selectedChangePath,
    selectedChangeKind, markdownViewMode, markdownSplitSourceWidthPct, svgViewMode,
    changesViewMode, searchItems, searchLoading, searchError, filePreview,
    setFilePreview, editorContent, setEditorContent, loadedContent, setLoadedContent,
    loadedMtimeMs, setLoadedMtimeMs, saveLoading, setSaveLoading, saveError,
    setSaveError, saveConflict, setSaveConflict, lastSavedAt, setLastSavedAt,
    fileLoading, setFileLoading, fileError, setFileError, changes, changesLoading,
    changesError, fileDiff, setFileDiff, diffLoading, setDiffLoading, diffError,
    setDiffError, fileRequestSequencer, diffRequestSequencer, selectedChangePathRef,
    selectedChangeKindRef, assetRefreshKey, setAssetRefreshKey, markdownScrollRatio,
    setMarkdownScrollRatio, pathCopied, setPathCopied, pathCopiedTimeoutRef,
    deleteTarget, setDeleteTarget, renameTarget, setRenameTarget, renamePath,
    setRenamePath, mutationPending, setMutationPending, mutationError, setMutationError,
    projectId, hasProjectPath, absoluteInput, panelWidth, fileKind, isFileEditable,
    isDirty, confirmDiscardDraft, handleRequestError, loadFile, loadDiff, loadChanges,
    saveFile, selectedPath, copyPath, refreshFileSearch,
  };
}
