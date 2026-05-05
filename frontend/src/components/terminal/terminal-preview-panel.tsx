import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
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
  deleteTerminalProjectPreviewFile,
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  renameTerminalProjectPreviewFile,
  saveTerminalProjectPreviewFile,
  searchTerminalProjectPreviewFiles,
} from "../../services/terminal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { TerminalPreviewPanelContent } from "./terminal-preview-panel-content";
import { useTerminalPreviewPanelActions } from "./terminal-preview-panel-actions";
import { TerminalPreviewPanelShell } from "./terminal-preview-panel-shell";

interface TerminalPreviewPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  widthPx?: number;
  onAuthExpired?: () => void;
  onEditProject: () => void;
}

interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

function resolveSelectedChange(params: {
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

export function TerminalPreviewPanel({
  apiBase,
  token,
  activeProject,
  widthPx,
  onAuthExpired,
  onEditProject,
}: TerminalPreviewPanelProps) {
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
  const fileRequestIdRef = useRef(0);
  const changesRequestIdRef = useRef(0);
  const diffRequestIdRef = useRef(0);
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
    mode === "file" &&
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
      const requestId = fileRequestIdRef.current + 1;
      fileRequestIdRef.current = requestId;
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
        if (fileRequestIdRef.current !== requestId) {
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
        if (fileRequestIdRef.current !== requestId) {
          return;
        }
        setFilePreview(null);
        setFileError(handleRequestError(error));
      } finally {
        if (fileRequestIdRef.current === requestId) {
          setFileLoading(false);
        }
      }
    },
    [apiBase, handleRequestError, projectId, token],
  );

  const loadDiff = useCallback(
    async (
      filePath: string,
      kind: TerminalPreviewChangeKind,
    ): Promise<void> => {
      if (!projectId) {
        return;
      }
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      setDiffLoading(true);
      setDiffError(null);
      try {
        const payload = await getTerminalProjectPreviewFileDiff(
          apiBase,
          token,
          projectId,
          { path: filePath, kind },
        );
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        setFileDiff(payload);
      } catch (error) {
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        setFileDiff(null);
        setDiffError(handleRequestError(error));
      } finally {
        if (diffRequestIdRef.current === requestId) {
          setDiffLoading(false);
        }
      }
    },
    [apiBase, handleRequestError, projectId, token],
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
      const requestId = changesRequestIdRef.current + 1;
      changesRequestIdRef.current = requestId;
      setChangesLoading(true);
      setChangesError(null);
      try {
        const payload = await getTerminalProjectPreviewGitChanges(
          apiBase,
          token,
          projectId,
        );
        if (changesRequestIdRef.current !== requestId) {
          return;
        }
        setChanges(payload);
        const selected = resolveSelectedChange({
          changes: payload,
          selectedChangePath: selectedChangePathRef.current,
          selectedChangeKind: selectedChangeKindRef.current,
        });
        if (!selected) {
          diffRequestIdRef.current += 1;
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
        if (changesRequestIdRef.current !== requestId) {
          return;
        }
        setChangesError(handleRequestError(error));
      } finally {
        if (changesRequestIdRef.current === requestId) {
          setChangesLoading(false);
        }
      }
    },
    [
      apiBase,
      handleRequestError,
      loadDiff,
      projectId,
      token,
      updateProjectPreview,
    ],
  );

  useEffect(() => {
    fileRequestIdRef.current += 1;
    changesRequestIdRef.current += 1;
    diffRequestIdRef.current += 1;
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
  }, [projectId]);

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
    if (mode !== "file" || !selectedFilePath) {
      return;
    }
    if (isSupportedTerminalImagePreviewPath(selectedFilePath)) {
      fileRequestIdRef.current += 1;
      setFilePreview(null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    void loadFile(selectedFilePath);
  }, [loadFile, mode, selectedFilePath]);

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (!isFileEditable) {
          return;
        }
        event.preventDefault();
        void saveFile();
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

  const selectedPath = useMemo(() => {
    if (mode === "file") {
      return selectedFilePath ?? filePreview?.path ?? null;
    }
    if (mode === "changes") {
      return selectedChangePath ?? fileDiff?.path ?? null;
    }
    return null;
  }, [
    fileDiff?.path,
    filePreview?.path,
    mode,
    selectedChangePath,
    selectedFilePath,
  ]);

  const copyPath = useMemo(() => {
    if (!selectedPath) {
      return null;
    }
    if (mode === "file" && filePreview?.absolutePath) {
      return filePreview.absolutePath;
    }
    if (mode === "changes" && fileDiff?.absolutePath) {
      return fileDiff.absolutePath;
    }
    if (selectedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(selectedPath)) {
      return selectedPath;
    }
    if (!activeProject?.path) {
      return selectedPath;
    }
    const separator = activeProject.path.includes("\\") ? "\\" : "/";
    return `${activeProject.path.replace(/[\\/]+$/, "")}${separator}${selectedPath.replace(/^[\\/]+/, "")}`;
  }, [
    activeProject?.path,
    fileDiff?.absolutePath,
    filePreview?.absolutePath,
    mode,
    selectedPath,
  ]);

  useEffect(() => {
    setPathCopied(false);
  }, [copyPath]);

  useEffect(() => {
    return () => {
      if (pathCopiedTimeoutRef.current !== null) {
        window.clearTimeout(pathCopiedTimeoutRef.current);
      }
    };
  }, []);

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

  const getMutationTarget = useCallback(
    (filePath: string): PreviewFileMutationTarget => ({
      path: filePath,
      expectedMtimeMs:
        filePreview?.base === "project" &&
        filePreview.path === filePath &&
        loadedMtimeMs !== undefined
          ? loadedMtimeMs
          : undefined,
    }),
    [filePreview, loadedMtimeMs],
  );

  const requestRenameFile = useCallback(
    (filePath: string): void => {
      if (!projectId || !confirmDiscardDraft()) {
        return;
      }
      const target = getMutationTarget(filePath);
      setMutationError(null);
      setRenameTarget(target);
      setRenamePath(target.path);
    },
    [confirmDiscardDraft, getMutationTarget, projectId],
  );

  const requestDeleteFile = useCallback(
    (filePath: string): void => {
      if (!projectId || !confirmDiscardDraft()) {
        return;
      }
      setMutationError(null);
      setDeleteTarget(getMutationTarget(filePath));
    },
    [confirmDiscardDraft, getMutationTarget, projectId],
  );

  const submitRenameFile = useCallback(async (): Promise<void> => {
    if (!projectId || !renameTarget || mutationPending) {
      return;
    }
    const nextPath = renamePath.trim();
    if (!nextPath) {
      setMutationError("New file path is required.");
      return;
    }
    setMutationPending("rename");
    setMutationError(null);
    try {
      const payload = await renameTerminalProjectPreviewFile(
        apiBase,
        token,
        projectId,
        {
          path: renameTarget.path,
          nextPath,
          expectedMtimeMs: renameTarget.expectedMtimeMs,
        },
      );
      fileRequestIdRef.current += 1;
      diffRequestIdRef.current += 1;
      selectedChangePathRef.current = undefined;
      selectedChangeKindRef.current = undefined;
      setFilePreview(payload);
      setEditorContent(payload.content);
      setLoadedContent(payload.content);
      setLoadedMtimeMs(payload.mtimeMs);
      setSaveError(null);
      setSaveConflict(false);
      setLastSavedAt(null);
      setFileError(null);
      setFileLoading(false);
      setFileDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      updateProjectPreview(projectId, {
        mode: "file",
        selectedFilePath: payload.path,
        openFileQuery: payload.path,
        selectedChangePath: undefined,
        selectedChangeKind: undefined,
      });
      setRenameTarget(null);
      setRenamePath("");
      await refreshFileSearch();
      void loadChanges({ reloadDiff: false, preserveMode: true });
    } catch (error) {
      setMutationError(handleRequestError(error));
    } finally {
      setMutationPending(null);
    }
  }, [
    apiBase,
    handleRequestError,
    loadChanges,
    mutationPending,
    projectId,
    refreshFileSearch,
    renamePath,
    renameTarget,
    token,
    updateProjectPreview,
  ]);

  const submitDeleteFile = useCallback(async (): Promise<void> => {
    if (!projectId || !deleteTarget || mutationPending) {
      return;
    }
    setMutationPending("delete");
    setMutationError(null);
    try {
      await deleteTerminalProjectPreviewFile(apiBase, token, projectId, {
        path: deleteTarget.path,
        expectedMtimeMs: deleteTarget.expectedMtimeMs,
      });
      const deletedSelectedFile =
        selectedFilePath === deleteTarget.path ||
        filePreview?.path === deleteTarget.path;
      const deletedSelectedChange = selectedChangePath === deleteTarget.path;
      if (deletedSelectedFile) {
        fileRequestIdRef.current += 1;
        setFilePreview(null);
        setEditorContent("");
        setLoadedContent("");
        setLoadedMtimeMs(undefined);
        setSaveError(null);
        setSaveConflict(false);
        setLastSavedAt(null);
        setFileError(null);
        setFileLoading(false);
      }
      if (deletedSelectedChange) {
        diffRequestIdRef.current += 1;
        selectedChangePathRef.current = undefined;
        selectedChangeKindRef.current = undefined;
        setFileDiff(null);
        setDiffError(null);
        setDiffLoading(false);
      }
      if (deletedSelectedFile || deletedSelectedChange) {
        updateProjectPreview(projectId, {
          selectedFilePath: deletedSelectedFile ? undefined : selectedFilePath,
          selectedChangePath: deletedSelectedChange
            ? undefined
            : selectedChangePath,
          selectedChangeKind: deletedSelectedChange
            ? undefined
            : selectedChangeKind,
        });
      }
      setDeleteTarget(null);
      await refreshFileSearch();
      void loadChanges({
        reloadDiff: !deletedSelectedChange,
        preserveMode: mode !== "changes",
      });
    } catch (error) {
      setMutationError(handleRequestError(error));
    } finally {
      setMutationPending(null);
    }
  }, [
    apiBase,
    deleteTarget,
    filePreview?.path,
    handleRequestError,
    loadChanges,
    mode,
    mutationPending,
    projectId,
    refreshFileSearch,
    selectedChangeKind,
    selectedChangePath,
    selectedFilePath,
    token,
    updateProjectPreview,
  ]);

  const {
    copyPath: copySelectedPath,
    openFilePath,
    refresh,
    setChangesViewMode,
    setMarkdownViewMode,
    setSvgViewMode,
    startMarkdownResize,
    startResize,
  } = useTerminalPreviewPanelActions({
    expanded,
    mode,
    projectId,
    query,
    selectedFilePath,
    copyPath,
    loadFile: async (filePath) => {
      if (isSupportedTerminalImagePreviewPath(filePath)) {
        setAssetRefreshKey((current) => current + 1);
        return;
      }
      await loadFile(filePath);
    },
    loadChanges,
    setWidth,
    updateProjectPreview,
    setFilePreview: () => setFilePreview(null),
    setFileError,
    setMarkdownScrollRatio,
    confirmDiscardDraft,
  });

  const body = (
    <TerminalPreviewPanelContent
      activeProject={activeProject}
      apiBase={apiBase}
      token={token}
      mode={mode}
      projectId={projectId}
      hasProjectPath={hasProjectPath}
      query={query}
      absoluteInput={absoluteInput}
      selectedFilePath={selectedFilePath}
      selectedChangePath={selectedChangePath}
      selectedChangeKind={selectedChangeKind}
      markdownViewMode={markdownViewMode}
      markdownSplitSourceWidthPct={markdownSplitSourceWidthPct}
      svgViewMode={svgViewMode}
      changesViewMode={changesViewMode}
      searchItems={searchItems}
      searchLoading={searchLoading}
      searchError={searchError}
      filePreview={filePreview}
      editorContent={editorContent}
      editable={isFileEditable}
      onEditorContentChange={(content) => {
        setEditorContent(content);
        setSaveError(null);
        setSaveConflict(false);
      }}
      saveError={saveError}
      saveConflict={saveConflict}
      onReloadFile={() => {
        if (selectedFilePath && confirmDiscardDraft()) {
          void loadFile(selectedFilePath);
        }
      }}
      onOverwriteFile={() => void saveFile({ overwrite: true })}
      fileLoading={fileLoading}
      fileError={fileError}
      changes={changes}
      changesLoading={changesLoading}
      changesError={changesError}
      fileDiff={fileDiff}
      diffLoading={diffLoading}
      diffError={diffError}
      assetRefreshKey={assetRefreshKey}
      markdownScrollRatio={markdownScrollRatio}
      onAuthExpired={onAuthExpired}
      onEditProject={onEditProject}
      onQueryChange={(nextQuery) => {
        if (projectId) {
          updateProjectPreview(projectId, {
            mode: "file",
            openFileQuery: nextQuery,
            selectedFilePath: undefined,
          });
        }
      }}
      onOpenFilePath={openFilePath}
      onRequestRenameFile={requestRenameFile}
      onRequestDeleteFile={requestDeleteFile}
      onSelectChange={(filePath, kind) => {
        if (!projectId) {
          return;
        }
        updateProjectPreview(projectId, {
          mode: "changes",
          selectedChangePath: filePath,
          selectedChangeKind: kind,
        });
      }}
      onReloadDiff={(filePath, kind) => {
        void loadDiff(filePath, kind);
      }}
      onMarkdownScrollRatioChange={setMarkdownScrollRatio}
      onStartMarkdownResize={startMarkdownResize}
      onOpenModeFile={() => {
        if (projectId) {
          updateProjectPreview(projectId, { mode: "file" });
        }
      }}
      onOpenModeChanges={() => {
        if (projectId && confirmDiscardDraft()) {
          updateProjectPreview(projectId, { mode: "changes" });
        }
      }}
    />
  );

  return (
    <>
      <TerminalPreviewPanelShell
        panelWidth={panelWidth}
        expanded={expanded}
        activeTool={activeTool}
        mode={mode}
        fileKind={
          mode === "changes" && selectedChangePath
            ? getTerminalPreviewFileKind(selectedChangePath, null)
            : fileKind
        }
        fileLoading={fileLoading}
        changesLoading={changesLoading}
        saveLoading={saveLoading}
        saveDisabled={!isDirty || !isFileEditable || saveLoading}
        saveStatus={
          saveConflict
            ? "conflict"
            : saveLoading
              ? "saving"
              : isDirty
                ? "unsaved"
                : isFileEditable && lastSavedAt
                  ? "saved"
                  : isFileEditable
                    ? "editable"
                    : "readonly"
        }
        canSave={isFileEditable}
        selectedPath={selectedPath}
        pathCopied={pathCopied}
        markdownViewMode={markdownViewMode}
        svgViewMode={svgViewMode}
        changesViewMode={changesViewMode}
        selectedChangePath={selectedChangePath}
        activeProject={activeProject}
        body={body}
        onStartResize={startResize}
        onSetActiveTool={setActiveTool}
        onSetPreviewMode={(nextMode) => {
          if (projectId && confirmDiscardDraft()) {
            updateProjectPreview(projectId, { mode: nextMode });
          }
        }}
        onToggleExpanded={() => setExpanded(!expanded)}
        onRefresh={refresh}
        onSave={() => void saveFile()}
        onCopyPath={() => {
          void copySelectedPath().then((copied) => {
            if (!copied) {
              return;
            }
            setPathCopied(true);
            if (pathCopiedTimeoutRef.current !== null) {
              window.clearTimeout(pathCopiedTimeoutRef.current);
            }
            pathCopiedTimeoutRef.current = window.setTimeout(() => {
              setPathCopied(false);
              pathCopiedTimeoutRef.current = null;
            }, 1500);
          });
        }}
        onClosePreview={() => {
          if (confirmDiscardDraft()) {
            closePreview();
          }
        }}
        onSetMarkdownViewMode={setMarkdownViewMode}
        onSetSvgViewMode={setSvgViewMode}
        onSetChangesViewMode={setChangesViewMode}
      />

      {renameTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-rename-title"
            className="w-full max-w-md rounded-[1.75rem] border border-slate-800/80 bg-slate-950 p-6 shadow-[0_34px_120px_-72px_rgba(15,23,42,0.92)]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  id="preview-rename-title"
                  className="text-lg font-semibold text-slate-100"
                >
                  Rename File
                </h2>
                <p className="mt-1 truncate text-sm text-slate-400">
                  {renameTarget.path}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full px-3 text-slate-300"
                disabled={mutationPending === "rename"}
                onClick={() => {
                  setRenameTarget(null);
                  setRenamePath("");
                  setMutationError(null);
                }}
              >
                Close
              </Button>
            </div>
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRenameFile();
              }}
            >
              <div className="space-y-2">
                <label
                  className="text-xs uppercase tracking-[0.24em] text-slate-500"
                  htmlFor="preview-rename-path"
                >
                  New file path
                </label>
                <input
                  id="preview-rename-path"
                  value={renamePath}
                  onChange={(event) => {
                    setRenamePath(event.target.value);
                    setMutationError(null);
                  }}
                  className="h-12 w-full rounded-[1.25rem] border border-slate-800 bg-slate-900/80 px-4 text-sm text-slate-100 outline-none transition focus:border-slate-500"
                  autoFocus
                />
              </div>
              {mutationError ? (
                <p className="text-sm text-rose-400" role="alert">
                  {mutationError}
                </p>
              ) : null}
              <Button
                type="submit"
                className="h-12 w-full rounded-full text-sm"
                disabled={mutationPending === "rename"}
              >
                {mutationPending === "rename" ? "Renaming..." : "Rename File"}
              </Button>
            </form>
          </section>
        </div>
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && mutationPending !== "delete") {
            setDeleteTarget(null);
            setMutationError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete File</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the file from disk. This cannot be undone.
            </AlertDialogDescription>
            {deleteTarget ? (
              <p className="truncate text-sm text-slate-300">
                {deleteTarget.path}
              </p>
            ) : null}
          </AlertDialogHeader>
          {mutationError && deleteTarget ? (
            <p className="text-sm text-rose-400" role="alert">
              {mutationError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutationPending === "delete"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={mutationPending === "delete"}
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={(event) => {
                event.preventDefault();
                void submitDeleteFile();
              }}
            >
              {mutationPending === "delete" ? "Deleting..." : "Delete File"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
