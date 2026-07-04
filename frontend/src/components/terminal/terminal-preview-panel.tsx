import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type {
  TerminalPreviewChangeKind,
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
  resetTerminalProjectPreviewChange,
} from "../../services/terminal";
import { TerminalPreviewPanelContent } from "./terminal-preview-panel-content";
import { useTerminalPreviewPanelActions } from "./terminal-preview-panel-actions";
import { useTerminalPreviewPanelData } from "./use-terminal-preview-panel-data";
import { TerminalPreviewPanelMutationDialogs } from "./terminal-preview-panel-mutation-dialogs";
import { TerminalPreviewPanelShell } from "./terminal-preview-panel-shell";
import { TerminalPreviewQuickSearch } from "./terminal-preview-quick-search";
import { useTerminalPreviewQuickSearch } from "./use-terminal-preview-quick-search";
import type { TerminalPreviewLineTarget } from "./terminal-preview-file-view";
import { TerminalAgentTeamPanel } from "./terminal-agent-team-panel";
import { useTerminalFileTree } from "./use-terminal-file-tree";

interface TerminalPreviewPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  sessions: TerminalSessionListItem[];
  showAgentTeamTool: boolean;
  widthPx?: number;
  onAuthExpired?: () => void;
  onEditProject: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
  onPanelSplitEnabledChange?: (enabled: boolean) => void;
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

function shouldIgnoreQuickSearchShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (
    target.closest(
      "input, textarea, select, [contenteditable='true'], .monaco-editor, .xterm",
    )
  ) {
    return true;
  }
  return false;
}

export function TerminalPreviewPanel({
  apiBase,
  token,
  activeProject,
  activeSession,
  showAgentTeamTool,
  widthPx,
  onAuthExpired,
  onEditProject,
  onPanelSplitEnabledChange,
}: TerminalPreviewPanelProps) {
  const [lineTarget, setLineTarget] =
    useState<TerminalPreviewLineTarget | null>(null);
  const lineTargetSequenceRef = useRef(0);
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
    resetTarget,
    setResetTarget,
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

  useEffect(() => {
    if (activeTool === "agent-team" && !showAgentTeamTool) {
      setActiveTool("preview");
    }
  }, [activeTool, setActiveTool, showAgentTeamTool]);

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

  const requestResetChange = useMemoizedFn(
    (filePath: string, kind: TerminalPreviewChangeKind): void => {
      if (!projectId || !confirmDiscardDraft()) {
        return;
      }
      setMutationError(null);
      setResetTarget({ path: filePath, kind });
    },
  );

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

  const quickSearch = useTerminalPreviewQuickSearch({
    apiBase,
    token,
    projectId,
    onRequestError: handleRequestError,
  });

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

  const openQuickSearchFileResult = useMemoizedFn(
    (filePath: string, target?: { line: number; column: number }): void => {
      if (!projectId || !confirmDiscardDraft()) {
        return;
      }
      quickSearch.closeSearch();
      setActiveTool("preview");
      openFileInStore(projectId, filePath, "explorer");
      void fileTree.revealFile(filePath);
      setFilePreview(null);
      setFileError(null);
      setMarkdownScrollRatio(0);
      if (target) {
        lineTargetSequenceRef.current += 1;
        setLineTarget({
          path: filePath,
          line: target.line,
          column: target.column,
          key: `${filePath}:${target.line}:${target.column}:${lineTargetSequenceRef.current}`,
        });
      } else {
        setLineTarget(null);
      }
    },
  );

  const revealQuickSearchDirectory = useMemoizedFn((directoryPath: string): void => {
    if (!projectId) {
      return;
    }
    quickSearch.closeSearch();
    setActiveTool("preview");
    setProjectPreviewMode(projectId, "explorer");
    void fileTree.revealDirectory(directoryPath);
  });

  const handleQuickSearchShortcut = useMemoizedFn((event: KeyboardEvent): void => {
    if (
      quickSearch.open ||
      activeTool !== "preview" ||
      !projectId ||
      !hasProjectPath ||
      !(event.metaKey || event.ctrlKey) ||
      shouldIgnoreQuickSearchShortcut(event.target)
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "p" && !event.shiftKey) {
      event.preventDefault();
      quickSearch.openSearch("files");
      return;
    }
    if (key === "f" && event.shiftKey) {
      event.preventDefault();
      quickSearch.openSearch("content");
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleQuickSearchShortcut);
    return () => {
      window.removeEventListener("keydown", handleQuickSearchShortcut);
    };
  }, [handleQuickSearchShortcut]);

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

  const submitResetChange = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !resetTarget || mutationPending) {
      return;
    }
    setMutationPending("reset");
    setMutationError(null);
    try {
      await resetTerminalProjectPreviewChange(apiBase, token, projectId, {
        path: resetTarget.path,
        kind: resetTarget.kind,
      });
      const resetSelectedFile =
        selectedFilePath === resetTarget.path ||
        filePreview?.path === resetTarget.path;
      const resetSelectedChange =
        selectedChangePath === resetTarget.path &&
        selectedChangeKind === resetTarget.kind;
      if (resetSelectedFile) {
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
      if (resetSelectedChange) {
        diffRequestSequencer.invalidate();
        selectedChangePathRef.current = undefined;
        selectedChangeKindRef.current = undefined;
        setFileDiff(null);
        setDiffError(null);
        setDiffLoading(false);
      }
      if (resetSelectedFile || resetSelectedChange) {
        updateProjectPreview(projectId, {
          selectedFilePath: resetSelectedFile ? undefined : selectedFilePath,
          selectedChangePath: resetSelectedChange
            ? undefined
            : selectedChangePath,
          selectedChangeKind: resetSelectedChange
            ? undefined
            : selectedChangeKind,
        });
      }
      setResetTarget(null);
      invalidateFileTreeParents([resetTarget.path]);
      await refreshFileSearch();
      void loadChanges({
        reloadDiff: !resetSelectedChange,
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
      lineTarget={lineTarget}
      onAuthExpired={onAuthExpired}
      onEditProject={onEditProject}
      onQueryChange={(nextQuery) => {
        if (projectId) {
          setOpenFileQuery(projectId, nextQuery);
        }
      }}
      onOpenFilePath={openFilePath}
      onOpenQuickSearch={() => quickSearch.openSearch("files")}
      onRequestRenameFile={requestRenameFile}
      onRequestDeleteFile={requestDeleteFile}
      onRequestResetChange={requestResetChange}
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
  const agentTeamBody = (
    <TerminalAgentTeamPanel
      apiBase={apiBase}
      token={token}
      activeProject={activeProject}
      activeSession={activeSession}
      onPanelSplitEnabledChange={onPanelSplitEnabledChange}
      onAuthExpired={onAuthExpired}
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
        showAgentTeamTool={showAgentTeamTool}
        agentTeamBody={agentTeamBody}
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

      <TerminalPreviewQuickSearch
        open={quickSearch.open}
        mode={quickSearch.mode}
        query={quickSearch.query}
        results={quickSearch.results}
        loading={quickSearch.loading}
        error={quickSearch.error}
        truncated={quickSearch.truncated}
        onOpenChange={quickSearch.setOpen}
        onModeChange={quickSearch.setMode}
        onQueryChange={quickSearch.setQuery}
        onOpenFile={openQuickSearchFileResult}
        onRevealDirectory={revealQuickSearchDirectory}
      />

      <TerminalPreviewPanelMutationDialogs
        deleteTarget={deleteTarget}
        renameTarget={renameTarget}
        resetTarget={resetTarget}
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
        onCloseReset={() => {
          setResetTarget(null);
          setMutationError(null);
        }}
        onSubmitRename={() => void submitRenameFile()}
        onSubmitDelete={() => void submitDeleteFile()}
        onSubmitReset={() => void submitResetChange()}
      />
    </>
  );
}
