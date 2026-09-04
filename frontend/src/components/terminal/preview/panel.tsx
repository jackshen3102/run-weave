import { useMemoizedFn } from "ahooks";
import { useEffect, type ReactNode } from "react";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
} from "../../../features/terminal/preview-file-types";
import { useTerminalRuntime } from "../../../features/terminal/queries/terminal-runtime-provider";
import { Button } from "../../ui/button";
import { TerminalPreviewChangesView } from "./changes-view";
import { useTerminalPreviewPanelActions } from "./panel-actions";
import { useTerminalPreviewPanelData } from "./use-panel-data";
import {
  TerminalPreviewDeleteDialog,
  TerminalPreviewRenameDialog,
  TerminalPreviewResetDialog,
} from "./panel-mutation-dialogs";
import { TerminalPreviewPanelShell } from "./panel-shell";
import { TerminalPreviewQuickSearch } from "./quick-search";
import { useTerminalPreviewQuickSearch } from "./use-quick-search";
import { renderPreviewEmpty, TerminalPreviewFileView } from "./file-view";
import { TerminalAgentTeamPanel } from "../agent-team/panel";
import { TerminalRacePanel } from "../race/race-panel";
import { useTerminalFileTree } from "./use-file-tree";
import { useTerminalMarkdownReferenceActions } from "../markdown/use-actions";
import { useTerminalPreviewFileMutations } from "./use-file-mutations";
import { TerminalBrowserAutomationTool } from "../automation/tool";
interface TerminalPreviewPanelProps {
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  sessions: TerminalSessionListItem[];
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
  sessions,
  showAgentTeamTool,
  widthPx,
  onEditProject,
  onPanelSplitEnabledChange,
  onActiveAgentTeamRunChange,
}: TerminalPreviewPanelProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
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

  const quickSearch = useTerminalPreviewQuickSearch({
    apiBase, token, projectId,
    onRequestError: handleRequestError,
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
    refreshTree: () => fileTree.refreshTree(),
    refreshSearchIndex: quickSearch.refreshIndex,
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
  const markdownReference = useTerminalMarkdownReferenceActions({
    activeSession,
    projectId,
    selectedFilePath,
    setMarkdownViewMode: setMarkdownViewModeInStore,
  });

  const fileTree = useTerminalFileTree({
    apiBase,
    token,
    projectId,
    hasProjectPath,
    onOpenFilePath: openFilePath,
  });
  const { loadRootDirectory, resetTree, invalidateDirectory } = fileTree;
  const projectPath = activeProject?.path ?? null;

  useEffect(() => {
    resetTree();
  }, [projectId, projectPath, resetTree]);

  useEffect(() => {
    if (mode === "explorer") {
      void loadRootDirectory();
    }
  }, [loadRootDirectory, mode, projectId, projectPath]);

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
      markdownReference.setTarget(filePath, target);
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
          canInsertMarkdownReference: markdownReference.canInsert,
          lineTarget: markdownReference.lineTarget,
          markdownReferenceDisabledReason: markdownReference.disabledReason,
          markdownScrollRatio,
          markdownSplitSourceWidthPct,
          markdownViewMode,
          svgViewMode,
          onInsertMarkdownReference: markdownReference.insert,
          onMarkdownScrollRatioChange: setMarkdownScrollRatio,
          onRevealMarkdownSourceLine: markdownReference.revealSourceLine,
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
        markdownReference={{
          canInsert: markdownReference.canInsert,
          disabledReason: markdownReference.disabledReason,
          insert: markdownReference.insert,
          lineTarget: markdownReference.lineTarget,
          setTarget: markdownReference.setTarget,
        }}
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
          setViewMode: setChangesViewMode,
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
  const raceBody = <TerminalRacePanel />;
  const automationBody = (
    <TerminalBrowserAutomationTool
      active={activeTool === "automation"}
      sessions={sessions}
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
          fileLoading: fileLoading || fileTree.loadingDirectories.size > 0,
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
        automationBody={automationBody}
        body={previewBody}
        agentTeamBody={agentTeamBody}
        raceBody={raceBody}
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
