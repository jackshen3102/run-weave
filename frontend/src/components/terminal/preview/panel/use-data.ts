import { useEffect, useMemo, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useShallow } from "zustand/react/shallow";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewChangeScope,
  TerminalPreviewFileResponse,
  TerminalPreviewWritableChangeKind,
} from "@runweave/shared/terminal/preview";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import {
  DEFAULT_MARKDOWN_VIEW_MODE,
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../../../features/terminal/preview/store";
import { useTerminalPreviewQueries } from "../../../../features/terminal/queries/preview";
import { terminalQueryKeys } from "../../../../features/terminal/queries/keys";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
  isSupportedTerminalVideoPreviewPath,
} from "../../../../features/terminal/preview/file-types";
import { HttpError } from "../../../../services/http";
import {
  getTerminalProjectPreviewFile,
} from "../../../../services/terminal/preview";
import {
  useTerminalPreviewPanelKeyboardEffects,
} from "./use-keyboard";
import {
  getSelectedTerminalPreviewPath,
  getTerminalPreviewCopyPath,
} from "./paths";
import { useTerminalPreviewChangeRefresh } from "./use-change-refresh";
import { useTerminalPreviewFileEditor } from "../files/use-editor";

interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

interface PreviewChangeResetTarget {
  path: string;
  kind: TerminalPreviewWritableChangeKind;
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
  const {
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
    setChangesScopeInStore,
    setSelectedCommitOidInStore,
    setMarkdownViewModeInStore,
    setMarkdownSplitSourceWidthPct,
    setSvgViewModeInStore,
    setChangesViewModeInStore,
  } = useTerminalPreviewStore(
    useShallow((state) => ({
      closePreview: state.closePreview,
      setWidth: state.setWidth,
      expanded: state.ui.expanded,
      activeTool: state.ui.activeTool,
      setActiveTool: state.setActiveTool,
      setExpanded: state.setExpanded,
      updateProjectPreview: state.updateProjectPreview,
      setProjectPreviewMode: state.setProjectPreviewMode,
      setOpenFileQuery: state.setOpenFileQuery,
      openFileInStore: state.openFile,
      selectChange: state.selectChange,
      setChangesScopeInStore: state.setChangesScope,
      setSelectedCommitOidInStore: state.setSelectedCommitOid,
      setMarkdownViewModeInStore: state.setMarkdownViewMode,
      setMarkdownSplitSourceWidthPct: state.setMarkdownSplitSourceWidthPct,
      setSvgViewModeInStore: state.setSvgViewMode,
      setChangesViewModeInStore: state.setChangesViewMode,
    })),
  );
  const projectState = useTerminalPreviewStore((state) =>
    activeProject ? state.projects[activeProject.projectId] : undefined,
  );
  const connectionId = useTerminalPreviewStore((state) => state.connectionScope);
  const changesRefreshRevision = useTerminalPreviewStore((state) =>
    activeProject
      ? (state.changesRefreshRevisionByProjectId[
          activeProject.projectId
        ] ?? 0)
      : 0,
  );
  const mode = projectState?.mode ?? null;
  const query = projectState?.openFileQuery ?? "";
  const selectedFilePath = projectState?.selectedFilePath;
  const changesScope: TerminalPreviewChangeScope =
    projectState?.changesScope ?? "working";
  const selectedCommitOid = projectState?.selectedCommitOid;
  const selectedChangePath =
    changesScope === "branch"
      ? projectState?.selectedBranchChangePath
      : changesScope === "commits"
        ? projectState?.selectedCommitChangePath
        : projectState?.selectedChangePath;
  const selectedChangeKind: TerminalPreviewChangeKind | undefined =
    changesScope === "branch"
      ? selectedChangePath
        ? "branch"
        : undefined
      : changesScope === "commits"
        ? selectedChangePath
          ? "commit"
          : undefined
        : projectState?.selectedChangeKind;
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
    changesScope,
    selectedCommitOid,
    query,
    selectedFilePath,
    selectedChangePath,
    selectedChangeKind,
  });
  const filePreview = previewQueries.file.data ?? null;
  const changes = previewQueries.changes.data ?? null;
  const branchChanges = previewQueries.branchChanges.data ?? null;
  const branchCommits = previewQueries.branchCommits.data ?? null;
  const fileDiff = previewQueries.diff.data ?? null;
  const fileKind = selectedFilePath
    ? getTerminalPreviewFileKind(selectedFilePath, filePreview?.language)
    : "text";
  const isFileEditable =
    (mode === "file" || mode === "explorer") &&
    Boolean(filePreview) &&
    filePreview?.readonly === false &&
    fileKind !== "image" && fileKind !== "video";

  const setCachedFile = useMemoizedFn(
    (file: TerminalPreviewFileResponse | null) => {
      // A save response uses the canonical project-relative path; the active
      // query may have been opened with an absolute path to the same file.
      const path = file && file.absolutePath === filePreview?.absolutePath
        ? selectedFilePath ?? file.path
        : file?.path ?? selectedFilePath;
      if (!path) {
        return;
      }
      previewQueries.setFile(path, file ?? undefined);
    },
  );
  const editor = useTerminalPreviewFileEditor({
    apiBase,
    token,
    connectionId,
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
    if (!editor.isDirty) return true;
    if (!window.confirm("Discard unsaved Preview changes?")) return false;
    if (filePreview) editor.replaceLoadedFile(filePreview);
    return true;
  });
  const handleRequestError = useMemoizedFn((error: unknown): string => {
    if (error instanceof HttpError && error.status === 401) {
      onAuthExpired?.();
    }
    return error instanceof Error ? error.message : String(error);
  });

  const loadFile = useMemoizedFn(async (filePath: string): Promise<void> => {
    if (!projectId || (isSupportedTerminalImagePreviewPath(filePath) || isSupportedTerminalVideoPreviewPath(filePath))) {
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

  const { loadDiff, loadChanges, recoverStaleDiff } = useTerminalPreviewChangeRefresh({
    apiBase,
    token,
    projectId,
    projectPath: activeProject?.path,
    scope: previewQueries.scope,
    queryClient: previewQueries.queryClient,
    onError: handleRequestError,
  });

  const lastStaleRecoveryKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const err = previewQueries.diff.error;
    if (
      !err ||
      !projectId ||
      !selectedChangePath ||
      !selectedChangeKind ||
      !(err instanceof HttpError) ||
      err.status !== 409 ||
      err.code !== "terminal_preview_stale_diff"
    ) {
      return;
    }
    const recoveryKey = `${projectId}:${selectedChangeKind}:${selectedChangePath}:${previewQueries.activeBaseOid ?? previewQueries.activeCommitOid ?? ""}`;
    if (lastStaleRecoveryKeyRef.current === recoveryKey) {
      return;
    }
    lastStaleRecoveryKeyRef.current = recoveryKey;
    void recoverStaleDiff(selectedChangePath, selectedChangeKind);
  }, [
    previewQueries.activeBaseOid,
    previewQueries.activeCommitOid,
    previewQueries.diff.error,
    projectId,
    recoverStaleDiff,
    selectedChangeKind,
    selectedChangePath,
  ]);

  useEffect(() => {
    const err = previewQueries.branchCommits.error;
    if (
      !err ||
      !projectId ||
      changesScope !== "commits" ||
      !selectedCommitOid ||
      !(err instanceof HttpError) ||
      err.status !== 409
    ) {
      return;
    }
    setSelectedCommitOidInStore(projectId, undefined);
  }, [
    changesScope,
    previewQueries.branchCommits.error,
    projectId,
    selectedCommitOid,
    setSelectedCommitOidInStore,
  ]);

  useEffect(() => {
    if (!projectId || mode !== "changes") return;
    if (changesScope === "branch" && branchChanges?.state === "ready") {
      if (branchChanges.files.length === 0) {
        if (projectState?.selectedBranchChangePath) {
          useTerminalPreviewStore.getState().clearSelectedChange(projectId, "branch");
        }
        return;
      }
      const existing = projectState?.selectedBranchChangePath;
      if (!existing || !branchChanges.files.some((f) => f.path === existing)) {
        selectChange(projectId, branchChanges.files[0]!.path, "branch");
      }
    } else if (changesScope === "commits" && branchCommits?.state === "ready") {
      if (branchCommits.files.length === 0) {
        if (projectState?.selectedCommitChangePath) {
          useTerminalPreviewStore.getState().clearSelectedChange(projectId, "commits");
        }
        return;
      }
      const existing = projectState?.selectedCommitChangePath;
      if (!existing || !branchCommits.files.some((f) => f.path === existing)) {
        selectChange(projectId, branchCommits.files[0]!.path, "commit");
      }
    }
  }, [
    branchChanges,
    branchCommits,
    changesScope,
    mode,
    projectId,
    projectState?.selectedBranchChangePath,
    projectState?.selectedCommitChangePath,
    selectChange,
  ]);

  useEffect(() => {
    if (changesRefreshRevision === 0 || mode !== "changes") {
      return;
    }
    void loadChanges();
  }, [changesRefreshRevision, loadChanges, mode]);

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
          baseOid: changeKind === "branch" ? previewQueries.activeBaseOid : undefined,
          commitOid: changeKind === "commit" ? previewQueries.activeCommitOid : undefined,
        }),
        exact: true,
      });
    },
  );

  useEffect(() => {
    if (
      !projectId ||
      !hasProjectPath ||
      mode ||
      (!changes && !previewQueries.changes.isError)
    ) {
      return;
    }
    setProjectPreviewMode(
      projectId,
      changes?.repoRoot === null ? "explorer" : "changes",
    );
  }, [changes, hasProjectPath, mode, previewQueries.changes.isError, projectId, setProjectPreviewMode]);

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
    setChangesScopeInStore,
    setSelectedCommitOidInStore,
    setMarkdownViewModeInStore,
    setMarkdownSplitSourceWidthPct,
    setSvgViewModeInStore,
    setChangesViewModeInStore,
    mode,
    changesScope,
    selectedCommitOid,
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
    changesLoading:
      previewQueries.changes.isFetching ||
      (changesScope === "branch" && previewQueries.branchChanges.isFetching) ||
      (changesScope === "commits" && previewQueries.branchCommits.isFetching),
    changesError: previewQueries.changes.error
      ? handleRequestError(previewQueries.changes.error)
      : null,
    branchChanges,
    branchChangesLoading: previewQueries.branchChanges.isFetching,
    branchChangesError: previewQueries.branchChanges.error
      ? handleRequestError(previewQueries.branchChanges.error)
      : null,
    branchCommits,
    branchCommitsLoading: previewQueries.branchCommits.isFetching,
    branchCommitsError: previewQueries.branchCommits.error
      ? handleRequestError(previewQueries.branchCommits.error)
      : null,
    activeBaseOid: previewQueries.activeBaseOid,
    activeCommitOid: previewQueries.activeCommitOid,
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
