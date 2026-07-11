import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
} from "../../features/terminal/preview-file-types";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { Button } from "../ui/button";
import { TerminalPreviewChangesView } from "./terminal-preview-changes-view";
import { useTerminalPreviewPanelActions } from "./terminal-preview-panel-actions";
import { useTerminalPreviewPanelData } from "./use-terminal-preview-panel-data";
import {
  TerminalPreviewDeleteDialog,
  TerminalPreviewRenameDialog,
  TerminalPreviewResetDialog,
} from "./terminal-preview-panel-mutation-dialogs";
import { TerminalPreviewPanelShell } from "./terminal-preview-panel-shell";
import { TerminalPreviewQuickSearch } from "./terminal-preview-quick-search";
import { useTerminalPreviewQuickSearch } from "./use-terminal-preview-quick-search";
import {
  renderPreviewEmpty,
  TerminalPreviewFileView,
  type TerminalPreviewLineTarget,
} from "./terminal-preview-file-view";
import { TerminalAgentTeamPanel } from "./terminal-agent-team-panel";
import { useTerminalFileTree } from "./use-terminal-file-tree";
import { useTerminalPreviewFileMutations } from "./use-terminal-preview-file-mutations";

interface TerminalPreviewPanelProps {
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  showAgentTeamTool: boolean;
  widthPx?: number;
  onEditProject: () => void;
  onPanelSplitEnabledChange?: (enabled: boolean) => void;
  onActiveAgentTeamRunChange?: (active: boolean) => void;
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
  activeProject,
  activeSession,
  showAgentTeamTool,
  widthPx,
  onEditProject,
  onPanelSplitEnabledChange,
  onActiveAgentTeamRunChange,
}: TerminalPreviewPanelProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
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
    loadedMtimeMs,
    saveLoading,
    saveError,
    saveConflict,
    lastSavedAt,
    fileLoading,
    fileError,
    changes,
    changesLoading,
    changesError,
    fileDiff,
    diffLoading,
    diffError,
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
    confirmDiscardDraft,
    handleRequestError,
    loadFile,
    loadDiff,
    loadChanges,
    saveFile,
    replaceLoadedFile,
    clearEditor,
    clearFilePreview,
    clearFileDiff,
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
    clearFilePreview,
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

  const mutations = useTerminalPreviewFileMutations({
    cache: {
      clearDiff: clearFileDiff,
      clearFile: clearFilePreview,
      setFile: setFilePreview,
    },
    editor: {
      clear: clearEditor,
      confirmDiscard: confirmDiscardDraft,
      loadedMtimeMs,
      replaceFile: replaceLoadedFile,
    },
    filePreview,
    handleRequestError,
    projectId,
    refresh: {
      changes: loadChanges,
      fileSearch: refreshFileSearch,
      treeParents: invalidateFileTreeParents,
    },
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
      clearFilePreview(filePath);
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

  const revealQuickSearchDirectory = useMemoizedFn(
    (directoryPath: string): void => {
      if (!projectId) {
        return;
      }
      quickSearch.closeSearch();
      setActiveTool("preview");
      setProjectPreviewMode(projectId, "explorer");
      void fileTree.revealDirectory(directoryPath);
    },
  );

  const handleQuickSearchShortcut = useMemoizedFn(
    (event: KeyboardEvent): void => {
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
    },
  );

  useEffect(() => {
    window.addEventListener("keydown", handleQuickSearchShortcut);
    return () => {
      window.removeEventListener("keydown", handleQuickSearchShortcut);
    };
  }, [handleQuickSearchShortcut]);

  const openFileMode = (): void => {
    if (projectId) setProjectPreviewMode(projectId, "file");
  };
  const openChangesMode = (): void => {
    if (projectId && confirmDiscardDraft()) {
      setProjectPreviewMode(projectId, "changes");
    }
  };

  let previewBody: ReactNode;
  if (!activeProject) {
    previewBody = renderPreviewEmpty("No project selected");
  } else if (!hasProjectPath) {
    previewBody = renderPreviewEmpty(
      "Set a project path to use Preview",
      <Button
        type="button"
        size="sm"
        className="rounded-lg"
        onClick={onEditProject}
      >
        Set project path
      </Button>,
    );
  } else if (mode === "explorer" || mode === "file") {
    previewBody = (
      <TerminalPreviewFileView
        activeProject={activeProject}
        fileTree={fileTree}
        navigation={{
          absoluteInput,
          mode,
          query,
          searchError,
          searchItems,
          searchLoading,
          selectedFilePath,
          onOpenFilePath: openFilePath,
          onOpenQuickSearch: () => quickSearch.openSearch("files"),
          onQueryChange: (nextQuery) => {
            if (projectId) setOpenFileQuery(projectId, nextQuery);
          },
          onRequestDeleteFile: mutations.requestDelete,
          onRequestRenameFile: mutations.requestRename,
        }}
        file={{
          assetRefreshKey,
          data: filePreview,
          error: fileError,
          kind: fileKind,
          loading: fileLoading,
        }}
        editor={{
          content: editorContent,
          editable: isFileEditable,
          saveConflict,
          saveError,
          onContentChange: setEditorContent,
          onOverwrite: () => void saveFile({ overwrite: true }),
          onReload: () => {
            if (selectedFilePath && confirmDiscardDraft()) {
              void loadFile(selectedFilePath);
            }
          },
        }}
        display={{
          lineTarget,
          markdownScrollRatio,
          markdownSplitSourceWidthPct,
          markdownViewMode,
          svgViewMode,
          onMarkdownScrollRatioChange: setMarkdownScrollRatio,
          onStartMarkdownResize: startMarkdownResize,
        }}
      />
    );
  } else if (mode === "changes") {
    previewBody = (
      <TerminalPreviewChangesView
        activeProject={activeProject}
        changes={{
          data: changes,
          error: changesError,
          loading: changesLoading,
        }}
        diff={{ data: fileDiff, error: diffError, loading: diffLoading }}
        selection={{
          kind: selectedChangeKind,
          path: selectedChangePath,
          viewMode: changesViewMode,
        }}
        commands={{
          openFile: openFilePath,
          openFileMode,
          reloadDiff: (filePath, kind) => void loadDiff(filePath, kind),
          requestDelete: mutations.requestDelete,
          requestRename: mutations.requestRename,
          requestReset: mutations.requestReset,
          select: (filePath, kind) => {
            if (projectId) selectChange(projectId, filePath, kind);
          },
        }}
      />
    );
  } else {
    previewBody = renderPreviewEmpty(
      "No preview for this project",
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="rounded-lg"
          onClick={openFileMode}
        >
          Open file...
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-lg"
          onClick={openChangesMode}
        >
          Changes
        </Button>
      </div>,
    );
  }
  const agentTeamBody = (
    <TerminalAgentTeamPanel
      apiBase={apiBase}
      token={token}
      activeProject={activeProject}
      activeSession={activeSession}
      onPanelSplitEnabledChange={onPanelSplitEnabledChange}
      onActiveRunChange={onActiveAgentTeamRunChange}
      onAuthExpired={onAuthExpired}
    />
  );
  return (
    <>
      <TerminalPreviewPanelShell
        layout={{
          expanded,
          panelWidth,
          onClose: () => {
            if (confirmDiscardDraft()) closePreview();
          },
          onStartResize: startResize,
          onToggleExpanded: () => setExpanded(!expanded),
        }}
        tools={{
          activeTool,
          showAgentTeamTool,
          onSetActiveTool: setActiveTool,
        }}
        navigation={{
          activeProject,
          mode,
          onSetMode: (nextMode) => {
            if (projectId && confirmDiscardDraft()) {
              setProjectPreviewMode(projectId, nextMode);
            }
          },
        }}
        actions={{
          changesLoading,
          fileLoading,
          mode,
          onRefresh: refresh,
          copy: {
            copied: pathCopied,
            path: selectedPath,
            run: () => {
              void copySelectedPath().then((copied) => {
                if (!copied) return;
                setPathCopied(true);
                if (pathCopiedTimeoutRef.current !== null) {
                  window.clearTimeout(pathCopiedTimeoutRef.current);
                }
                pathCopiedTimeoutRef.current = window.setTimeout(() => {
                  setPathCopied(false);
                  pathCopiedTimeoutRef.current = null;
                }, 1500);
              });
            },
          },
          save: {
            available: isFileEditable,
            disabled: !isDirty || !isFileEditable || saveLoading,
            loading: saveLoading,
            run: () => void saveFile(),
            status: saveConflict
              ? "conflict"
              : saveLoading
                ? "saving"
                : isDirty
                  ? "unsaved"
                  : isFileEditable && lastSavedAt
                    ? "saved"
                    : isFileEditable
                      ? "editable"
                      : "readonly",
          },
        }}
        view={{
          changesViewMode,
          fileKind:
            mode === "changes" && selectedChangePath
              ? getTerminalPreviewFileKind(selectedChangePath, null)
              : fileKind,
          markdownViewMode,
          mode,
          selectedChangePath,
          selectedPath,
          svgViewMode,
          onSetChanges: setChangesViewMode,
          onSetMarkdown: setMarkdownViewMode,
          onSetSvg: setSvgViewMode,
        }}
        activeTerminalSessionId={activeSession?.terminalSessionId ?? null}
        body={previewBody}
        agentTeamBody={agentTeamBody}
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

      <TerminalPreviewRenameDialog
        error={mutations.error}
        path={mutations.renamePath}
        pending={mutations.pending === "rename"}
        target={mutations.renameTarget}
        onClearError={() => mutations.setError(null)}
        onClose={mutations.closeRename}
        onPathChange={mutations.setRenamePath}
        onSubmit={() => void mutations.submitRename()}
      />
      <TerminalPreviewDeleteDialog
        error={mutations.error}
        pending={mutations.pending === "delete"}
        target={mutations.deleteTarget}
        onClose={mutations.closeDelete}
        onSubmit={() => void mutations.submitDelete()}
      />
      <TerminalPreviewResetDialog
        error={mutations.error}
        pending={mutations.pending === "reset"}
        target={mutations.resetTarget}
        onClose={mutations.closeReset}
        onSubmit={() => void mutations.submitReset()}
      />
    </>
  );
}
