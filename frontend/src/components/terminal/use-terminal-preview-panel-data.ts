import { useEffect, useMemo, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileResponse,
} from "@runweave/shared/terminal/preview";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import {
  DEFAULT_MARKDOWN_VIEW_MODE,
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../features/terminal/preview-store";
import { useTerminalPreviewQueries } from "../../features/terminal/queries/terminal-preview-queries";
import { terminalQueryKeys } from "../../features/terminal/queries/terminal-query-keys";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
} from "../../features/terminal/preview-file-types";
import { HttpError } from "../../services/http";
import {
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
} from "../../services/terminal-preview";
import {
  resolveSelectedPreviewChange,
  useTerminalPreviewPanelKeyboardEffects,
} from "./use-terminal-preview-panel-keyboard-effects";
import {
  getSelectedTerminalPreviewPath,
  getTerminalPreviewCopyPath,
} from "./terminal-preview-panel-paths";
import { useTerminalPreviewFileEditor } from "./use-terminal-preview-file-editor";

interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

interface PreviewChangeResetTarget {
  path: string;
  kind: TerminalPreviewChangeKind;
}

interface UseTerminalPreviewPanelDataArgs {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  widthPx?: number;
  onAuthExpired?: () => void;
}

const EMPTY_SEARCH_ITEMS: never[] = [];

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
  const setProjectPreviewMode = useTerminalPreviewStore(
    (state) => state.setProjectPreviewMode,
  );
  const setOpenFileQuery = useTerminalPreviewStore(
    (state) => state.setOpenFileQuery,
  );
  const openFileInStore = useTerminalPreviewStore((state) => state.openFile);
  const selectChange = useTerminalPreviewStore((state) => state.selectChange);
  const clearSelectedChange = useTerminalPreviewStore(
    (state) => state.clearSelectedChange,
  );
  const setMarkdownViewModeInStore = useTerminalPreviewStore(
    (state) => state.setMarkdownViewMode,
  );
  const setMarkdownSplitSourceWidthPct = useTerminalPreviewStore(
    (state) => state.setMarkdownSplitSourceWidthPct,
  );
  const setSvgViewModeInStore = useTerminalPreviewStore(
    (state) => state.setSvgViewMode,
  );
  const setChangesViewModeInStore = useTerminalPreviewStore(
    (state) => state.setChangesViewMode,
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
  const projectId = activeProject?.projectId ?? null;
  const hasProjectPath = Boolean(activeProject?.path);
  const absoluteInput = query.trim().startsWith("/");
  const panelWidth = expanded
    ? "100%"
    : widthPx
      ? `${widthPx}px`
      : DEFAULT_TERMINAL_SIDECAR_WIDTH;

  const previewQueries = useTerminalPreviewQueries({
    projectId,
    hasProjectPath,
    mode,
    query,
    selectedFilePath,
    selectedChangePath,
    selectedChangeKind,
  });
  const filePreview = previewQueries.file.data ?? null;
  const changes = previewQueries.changes.data ?? null;
  const fileDiff = previewQueries.diff.data ?? null;
  const fileKind = selectedFilePath
    ? getTerminalPreviewFileKind(selectedFilePath, filePreview?.language)
    : "text";
  const isFileEditable =
    (mode === "file" || mode === "explorer") &&
    Boolean(filePreview) &&
    filePreview?.readonly === false &&
    fileKind !== "image";

  const setCachedFile = useMemoizedFn(
    (file: TerminalPreviewFileResponse | null) => {
      const path = file?.path ?? selectedFilePath;
      if (!path) {
        return;
      }
      previewQueries.setFile(path, file ?? undefined);
    },
  );
  const editor = useTerminalPreviewFileEditor({
    apiBase,
    token,
    projectId,
    selectedFilePath,
    filePreview,
    editable: isFileEditable,
    onAuthExpired,
    onFileSaved: setCachedFile,
  });

  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [markdownScrollRatio, setMarkdownScrollRatio] = useState(0);
  const [pathCopied, setPathCopied] = useState(false);
  const pathCopiedTimeoutRef = useRef<number | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<PreviewFileMutationTarget | null>(null);
  const [renameTarget, setRenameTarget] =
    useState<PreviewFileMutationTarget | null>(null);
  const [resetTarget, setResetTarget] =
    useState<PreviewChangeResetTarget | null>(null);
  const [renamePath, setRenamePath] = useState("");
  const [mutationPending, setMutationPending] = useState<
    "delete" | "rename" | "reset" | null
  >(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const confirmDiscardDraft = useMemoizedFn((): boolean => {
    return (
      !editor.isDirty || window.confirm("Discard unsaved Preview changes?")
    );
  });
  const handleRequestError = useMemoizedFn((error: unknown): string => {
    if (error instanceof HttpError && error.status === 401) {
      onAuthExpired?.();
    }
    return error instanceof Error ? error.message : String(error);
  });

  const loadFile = useMemoizedFn(async (filePath: string): Promise<void> => {
    if (!projectId || isSupportedTerminalImagePreviewPath(filePath)) {
      return;
    }
    await previewQueries.queryClient.fetchQuery({
      queryKey: terminalQueryKeys.previewFile({
        scope: previewQueries.scope,
        projectId,
        path: filePath,
      }),
      queryFn: () =>
        getTerminalProjectPreviewFile(apiBase, token, projectId, filePath),
      staleTime: 0,
    });
  });

  const loadDiff = useMemoizedFn(
    async (
      filePath: string,
      kind: TerminalPreviewChangeKind,
    ): Promise<void> => {
      if (!projectId) {
        return;
      }
      await previewQueries.queryClient.fetchQuery({
        queryKey: terminalQueryKeys.previewDiff({
          scope: previewQueries.scope,
          projectId,
          path: filePath,
          kind,
        }),
        queryFn: () =>
          getTerminalProjectPreviewFileDiff(apiBase, token, projectId, {
            path: filePath,
            kind,
          }),
        staleTime: 0,
      });
    },
  );

  const loadChanges = useMemoizedFn(
    async (options?: { preserveMode?: boolean }): Promise<void> => {
      if (!projectId) {
        return;
      }
      const payload = await previewQueries.queryClient.fetchQuery({
        queryKey: terminalQueryKeys.previewChanges(
          previewQueries.scope,
          projectId,
        ),
        queryFn: () =>
          getTerminalProjectPreviewGitChanges(apiBase, token, projectId),
        staleTime: 0,
      });
      const selected = resolveSelectedPreviewChange({
        changes: payload,
        selectedChangePath,
        selectedChangeKind,
      });
      if (!selected) {
        if (!options?.preserveMode) {
          setProjectPreviewMode(projectId, "changes");
          clearSelectedChange(projectId);
        }
        return;
      }
      if (
        !options?.preserveMode &&
        (selected.path !== selectedChangePath ||
          selected.kind !== selectedChangeKind)
      ) {
        selectChange(projectId, selected.path, selected.kind);
      }
    },
  );

  const clearFilePreview = useMemoizedFn((filePath?: string) => {
    const path = filePath ?? selectedFilePath;
    if (!projectId || !path) {
      return;
    }
    previewQueries.queryClient.removeQueries({
      queryKey: terminalQueryKeys.previewFile({
        scope: previewQueries.scope,
        projectId,
        path,
      }),
      exact: true,
    });
  });
  const clearFileDiff = useMemoizedFn(
    (filePath?: string, kind?: TerminalPreviewChangeKind) => {
      const path = filePath ?? selectedChangePath;
      const changeKind = kind ?? selectedChangeKind;
      if (!projectId || !path || !changeKind) {
        return;
      }
      previewQueries.queryClient.removeQueries({
        queryKey: terminalQueryKeys.previewDiff({
          scope: previewQueries.scope,
          projectId,
          path,
          kind: changeKind,
        }),
        exact: true,
      });
    },
  );

  useEffect(() => {
    if (!projectId || !hasProjectPath || mode) {
      return;
    }
    setProjectPreviewMode(projectId, "changes");
  }, [hasProjectPath, mode, projectId, setProjectPreviewMode]);

  useTerminalPreviewPanelKeyboardEffects({
    expanded,
    setExpanded,
    isFileEditable,
    saveFile: () => void editor.saveFile(),
    isDirty: editor.isDirty,
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

  const refreshFileSearch = useMemoizedFn(async (): Promise<void> => {
    await previewQueries.search.refetch();
  });

  return {
    closePreview,
    setWidth,
    expanded,
    activeTool,
    setActiveTool,
    setExpanded,
    updateProjectPreview,
    setProjectPreviewMode,
    setOpenFileQuery,
    openFileInStore,
    selectChange,
    setMarkdownViewModeInStore,
    setMarkdownSplitSourceWidthPct,
    setSvgViewModeInStore,
    setChangesViewModeInStore,
    mode,
    query,
    selectedFilePath,
    selectedChangePath,
    selectedChangeKind,
    markdownViewMode,
    markdownSplitSourceWidthPct,
    svgViewMode,
    changesViewMode,
    searchItems: previewQueries.search.data?.items ?? EMPTY_SEARCH_ITEMS,
    searchLoading:
      previewQueries.search.isFetching || previewQueries.searchPending,
    searchError: previewQueries.search.error
      ? handleRequestError(previewQueries.search.error)
      : null,
    filePreview,
    setFilePreview: setCachedFile,
    editorContent: editor.editorContent,
    setEditorContent: editor.setEditorContent,
    loadedMtimeMs: editor.loadedMtimeMs,
    saveLoading: editor.savePending,
    saveError: editor.saveError,
    saveConflict: editor.saveConflict,
    lastSavedAt: editor.lastSavedAt,
    fileLoading: previewQueries.file.isFetching,
    fileError: previewQueries.file.error
      ? handleRequestError(previewQueries.file.error)
      : null,
    changes,
    changesLoading: previewQueries.changes.isFetching,
    changesError: previewQueries.changes.error
      ? handleRequestError(previewQueries.changes.error)
      : null,
    fileDiff,
    diffLoading: previewQueries.diff.isFetching,
    diffError: previewQueries.diff.error
      ? handleRequestError(previewQueries.diff.error)
      : null,
    assetRefreshKey,
    setAssetRefreshKey,
    markdownScrollRatio,
    setMarkdownScrollRatio,
    pathCopied,
    setPathCopied,
    pathCopiedTimeoutRef,
    deleteTarget,
    setDeleteTarget,
    renameTarget,
    setRenameTarget,
    resetTarget,
    setResetTarget,
    renamePath,
    setRenamePath,
    mutationPending,
    setMutationPending,
    mutationError,
    setMutationError,
    projectId,
    hasProjectPath,
    absoluteInput,
    panelWidth,
    fileKind,
    isFileEditable,
    isDirty: editor.isDirty,
    confirmDiscardDraft,
    handleRequestError,
    loadFile,
    loadDiff,
    loadChanges,
    saveFile: editor.saveFile,
    replaceLoadedFile: editor.replaceLoadedFile,
    clearEditor: editor.clearEditor,
    clearFilePreview,
    clearFileDiff,
    selectedPath,
    copyPath,
    refreshFileSearch,
  };
}
