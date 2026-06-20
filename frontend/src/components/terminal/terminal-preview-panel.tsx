import { useMemoizedFn } from "ahooks";
import { useEffect } from "react";
import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
} from "@runweave/shared";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
} from "../../features/terminal/preview-file-types";
import {
  deleteTerminalProjectPreviewFile,
  renameTerminalProjectPreviewFile,
} from "../../services/terminal";
import { TerminalPreviewPanelContent } from "./terminal-preview-panel-content";
import { useTerminalPreviewPanelActions } from "./terminal-preview-panel-actions";
import { useTerminalPreviewPanelData } from "./use-terminal-preview-panel-data";
import { TerminalPreviewPanelMutationDialogs } from "./terminal-preview-panel-mutation-dialogs";
import { TerminalPreviewPanelShell } from "./terminal-preview-panel-shell";
import { TerminalOrchestratorPanel } from "./terminal-orchestrator-panel";
import { useTerminalFileTree } from "./use-terminal-file-tree";

interface TerminalPreviewPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  sessions: TerminalSessionListItem[];
  widthPx?: number;
  onAuthExpired?: () => void;
  onEditProject: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
}

interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

function getPreviewParentDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/g, "");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex > 0 ? normalized.slice(0, lastSlashIndex) : ".";
}

export function TerminalPreviewPanel({
  apiBase,
  token,
  activeProject,
  activeSession,
  sessions,
  widthPx,
  onAuthExpired,
  onEditProject,
  onSelectSession,
}: TerminalPreviewPanelProps) {
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
    searchItems,
    searchLoading,
    searchError,
    filePreview,
    setFilePreview,
    editorContent,
    setEditorContent,
    setLoadedContent,
    loadedMtimeMs,
    setLoadedMtimeMs,
    saveLoading,
    saveError,
    setSaveError,
    saveConflict,
    setSaveConflict,
    lastSavedAt,
    setLastSavedAt,
    fileLoading,
    setFileLoading,
    fileError,
    setFileError,
    changes,
    changesLoading,
    changesError,
    fileDiff,
    setFileDiff,
    diffLoading,
    setDiffLoading,
    diffError,
    setDiffError,
    fileRequestSequencer,
    diffRequestSequencer,
    selectedChangePathRef,
    selectedChangeKindRef,
    assetRefreshKey,
    setAssetRefreshKey,
    markdownScrollRatio,
    setMarkdownScrollRatio,
    pathCopied,
    setPathCopied,
    pathCopiedTimeoutRef,
    projectId,
    hasProjectPath,
    absoluteInput,
    panelWidth,
    fileKind,
    isFileEditable,
    isDirty,
    deleteTarget,
    setDeleteTarget,
    renameTarget,
    setRenameTarget,
    renamePath,
    setRenamePath,
    mutationPending,
    setMutationPending,
    mutationError,
    setMutationError,
    confirmDiscardDraft,
    handleRequestError,
    loadFile,
    loadDiff,
    loadChanges,
    saveFile,
    selectedPath,
    copyPath,
    refreshFileSearch,
  } = useTerminalPreviewPanelData({
    apiBase,
    token,
    activeProject,
    widthPx,
    onAuthExpired,
  });

  const getMutationTarget = useMemoizedFn(
    (filePath: string): PreviewFileMutationTarget => ({
      path: filePath,
      expectedMtimeMs:
        filePreview?.base === "project" &&
        filePreview.path === filePath &&
        loadedMtimeMs !== undefined
          ? loadedMtimeMs
          : undefined,
    }),
  );

  const requestRenameFile = useMemoizedFn((filePath: string): void => {
    if (!projectId || !confirmDiscardDraft()) {
      return;
    }
    const target = getMutationTarget(filePath);
    setMutationError(null);
    setRenameTarget(target);
    setRenamePath(target.path);
  });

  const requestDeleteFile = useMemoizedFn((filePath: string): void => {
    if (!projectId || !confirmDiscardDraft()) {
      return;
    }
    setMutationError(null);
    setDeleteTarget(getMutationTarget(filePath));
  });

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
    setOpenFileQuery,
    openFile: openFileInStore,
    setMarkdownViewModeInStore,
    setMarkdownSplitSourceWidthPct,
    setSvgViewModeInStore,
    setChangesViewModeInStore,
    setFilePreview: () => setFilePreview(null),
    setFileError,
    setMarkdownScrollRatio,
    confirmDiscardDraft,
  });

  const fileTree = useTerminalFileTree({
    apiBase,
    token,
    projectId,
    hasProjectPath,
    onOpenFilePath: openFilePath,
  });
  const { loadRootDirectory, resetTree, invalidateDirectory } = fileTree;

  useEffect(() => {
    resetTree();
  }, [projectId, hasProjectPath, resetTree]);

  useEffect(() => {
    if (mode === "explorer") {
      loadRootDirectory();
    }
  }, [loadRootDirectory, mode]);

  const invalidateFileTreeParents = useMemoizedFn((paths: string[]): void => {
    const directories = new Set(paths.map(getPreviewParentDirectory));
    for (const directoryPath of directories) {
      invalidateDirectory(directoryPath);
    }
  });

  const submitRenameFile = useMemoizedFn(async (): Promise<void> => {
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
      fileRequestSequencer.invalidate();
      diffRequestSequencer.invalidate();
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
      invalidateFileTreeParents([renameTarget.path, payload.path]);
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
  });

  const submitDeleteFile = useMemoizedFn(async (): Promise<void> => {
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
        fileRequestSequencer.invalidate();
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
        diffRequestSequencer.invalidate();
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
      invalidateFileTreeParents([deleteTarget.path]);
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
  });

  const previewBody = (
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
      fileTree={fileTree}
      assetRefreshKey={assetRefreshKey}
      markdownScrollRatio={markdownScrollRatio}
      onAuthExpired={onAuthExpired}
      onEditProject={onEditProject}
      onQueryChange={(nextQuery) => {
        if (projectId) {
          setOpenFileQuery(projectId, nextQuery);
        }
      }}
      onOpenFilePath={openFilePath}
      onRequestRenameFile={requestRenameFile}
      onRequestDeleteFile={requestDeleteFile}
      onSelectChange={(filePath, kind) => {
        if (!projectId) {
          return;
        }
        selectChange(projectId, filePath, kind);
      }}
      onReloadDiff={(filePath, kind) => {
        void loadDiff(filePath, kind);
      }}
      onMarkdownScrollRatioChange={setMarkdownScrollRatio}
      onStartMarkdownResize={startMarkdownResize}
      onOpenModeFile={() => {
        if (projectId) {
          setProjectPreviewMode(projectId, "file");
        }
      }}
      onOpenModeChanges={() => {
        if (projectId && confirmDiscardDraft()) {
          setProjectPreviewMode(projectId, "changes");
        }
      }}
    />
  );
  const orchestratorBody = (
    <TerminalOrchestratorPanel
      apiBase={apiBase}
      token={token}
      activeProject={activeProject}
      sessions={sessions}
      onAuthExpired={onAuthExpired}
      onSelectSession={onSelectSession}
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
        apiBase={apiBase}
        token={token}
        activeTerminalSessionId={activeSession?.terminalSessionId ?? null}
        body={previewBody}
        orchestratorBody={orchestratorBody}
        onStartResize={startResize}
        onSetActiveTool={setActiveTool}
        onSetPreviewMode={(nextMode) => {
          if (projectId && confirmDiscardDraft()) {
            setProjectPreviewMode(projectId, nextMode);
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

      <TerminalPreviewPanelMutationDialogs
        deleteTarget={deleteTarget}
        renameTarget={renameTarget}
        renamePath={renamePath}
        mutationPending={mutationPending}
        mutationError={mutationError}
        onRenamePathChange={setRenamePath}
        onClearMutationError={() => setMutationError(null)}
        onCloseRename={() => {
          setRenameTarget(null);
          setRenamePath("");
          setMutationError(null);
        }}
        onCloseDelete={() => {
          setDeleteTarget(null);
          setMutationError(null);
        }}
        onSubmitRename={() => void submitRenameFile()}
        onSubmitDelete={() => void submitDeleteFile()}
      />
    </>
  );
}
