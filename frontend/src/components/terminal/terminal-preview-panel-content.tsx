import {
  Suspense,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import type {
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalSvgViewMode,
} from "../../features/terminal/preview-store";
import {
  extensionToLanguageHint,
  getTerminalPreviewFileKind,
  getTerminalPreviewMonacoLanguage,
} from "../../features/terminal/preview-file-types";
import { Button } from "../ui/button";
import {
  renderPreviewEmpty,
  TerminalImagePreview,
  TerminalMarkdownPreview,
  TerminalMonacoViewer,
  TerminalPreviewFileView,
  TerminalSvgPreview,
} from "./terminal-preview-file-view";
import { TerminalPreviewChangeTree } from "./terminal-preview-change-tree";
import type { UseTerminalFileTreeReturn } from "./use-terminal-file-tree";

interface TerminalPreviewPanelContentProps {
  activeProject: TerminalProjectListItem | null;
  apiBase: string;
  token: string;
  mode: string | null;
  projectId: string | null;
  hasProjectPath: boolean;
  query: string;
  absoluteInput: boolean;
  selectedFilePath?: string;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
  markdownViewMode: TerminalMarkdownViewMode;
  markdownSplitSourceWidthPct: number;
  svgViewMode: TerminalSvgViewMode;
  changesViewMode: TerminalChangesViewMode;
  searchItems: TerminalPreviewFileSearchItem[];
  searchLoading: boolean;
  searchError: string | null;
  filePreview: TerminalPreviewFileResponse | null;
  editorContent: string;
  editable: boolean;
  onEditorContentChange: (content: string) => void;
  saveError: string | null;
  saveConflict: boolean;
  onReloadFile: () => void;
  onOverwriteFile: () => void;
  fileLoading: boolean;
  fileError: string | null;
  changes: TerminalPreviewGitChangesResponse | null;
  changesLoading: boolean;
  changesError: string | null;
  fileDiff: TerminalPreviewFileDiffResponse | null;
  diffLoading: boolean;
  diffError: string | null;
  fileTree: UseTerminalFileTreeReturn;
  assetRefreshKey: number;
  markdownScrollRatio: number;
  onAuthExpired?: () => void;
  onEditProject: () => void;
  onQueryChange: (nextQuery: string) => void;
  onOpenFilePath: (filePath: string) => void;
  onRequestRenameFile: (filePath: string) => void;
  onRequestDeleteFile: (filePath: string) => void;
  onSelectChange: (filePath: string, kind: TerminalPreviewChangeKind) => void;
  onReloadDiff: (filePath: string, kind: TerminalPreviewChangeKind) => void;
  onMarkdownScrollRatioChange: (ratio: number) => void;
  onStartMarkdownResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenModeFile: () => void;
  onOpenModeChanges: () => void;
}

export function TerminalPreviewPanelContent({
  activeProject,
  apiBase,
  token,
  mode,
  projectId,
  hasProjectPath,
  query,
  absoluteInput,
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
  editorContent,
  editable,
  onEditorContentChange,
  saveError,
  saveConflict,
  onReloadFile,
  onOverwriteFile,
  fileLoading,
  fileError,
  changes,
  changesLoading,
  changesError,
  fileDiff,
  diffLoading,
  diffError,
  fileTree,
  assetRefreshKey,
  markdownScrollRatio,
  onAuthExpired,
  onEditProject,
  onQueryChange,
  onOpenFilePath,
  onRequestRenameFile,
  onRequestDeleteFile,
  onSelectChange,
  onReloadDiff,
  onMarkdownScrollRatioChange,
  onStartMarkdownResize,
  onOpenModeFile,
  onOpenModeChanges,
}: TerminalPreviewPanelContentProps) {
  const fileKind = selectedFilePath
    ? getTerminalPreviewFileKind(selectedFilePath, filePreview?.language)
    : "text";

  if (!activeProject) {
    return renderPreviewEmpty("No project selected");
  }

  if (!hasProjectPath) {
    return renderPreviewEmpty(
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
  }

  if (mode === "explorer" || mode === "file") {
    return (
      <TerminalPreviewFileView
        activeProject={activeProject}
        apiBase={apiBase}
        token={token}
        mode={mode}
        projectId={projectId}
        query={query}
        absoluteInput={absoluteInput}
        selectedFilePath={selectedFilePath}
        fileKind={fileKind}
        markdownViewMode={markdownViewMode}
        markdownSplitSourceWidthPct={markdownSplitSourceWidthPct}
        svgViewMode={svgViewMode}
        searchItems={searchItems}
        searchLoading={searchLoading}
        searchError={searchError}
        filePreview={filePreview}
        editorContent={editorContent}
        editable={editable}
        onEditorContentChange={onEditorContentChange}
        saveError={saveError}
        saveConflict={saveConflict}
        onReloadFile={onReloadFile}
        onOverwriteFile={onOverwriteFile}
        fileLoading={fileLoading}
        fileError={fileError}
        fileTree={fileTree}
        assetRefreshKey={assetRefreshKey}
        markdownScrollRatio={markdownScrollRatio}
        onAuthExpired={onAuthExpired}
        onQueryChange={onQueryChange}
        onOpenFilePath={onOpenFilePath}
        onRequestRenameFile={onRequestRenameFile}
        onRequestDeleteFile={onRequestDeleteFile}
        onMarkdownScrollRatioChange={onMarkdownScrollRatioChange}
        onStartMarkdownResize={onStartMarkdownResize}
      />
    );
  }

  if (mode === "changes") {
    const changeDiffFileKind = selectedChangePath
      ? getTerminalPreviewFileKind(selectedChangePath, null)
      : "text";
    const changeDiffLanguageHint = selectedChangePath
      ? extensionToLanguageHint(selectedChangePath)
      : null;
    const changeDiffMonacoLanguage = getTerminalPreviewMonacoLanguage(
      changeDiffLanguageHint,
    );
    const isChangeImageDeleted =
      changeDiffFileKind === "image" && fileDiff?.status === "deleted";

    let changeContent: ReactNode;
    if (diffLoading && !fileDiff) {
      changeContent = renderPreviewEmpty("Loading diff...");
    } else if (diffError) {
      changeContent = renderPreviewEmpty(diffError);
    } else if (!fileDiff) {
      changeContent = renderPreviewEmpty("Select a changed file");
    } else if (changeDiffFileKind === "image") {
      if (isChangeImageDeleted) {
        changeContent = renderPreviewEmpty("Image deleted");
      } else if (selectedChangePath && projectId) {
        changeContent = (
          <Suspense fallback={renderPreviewEmpty("Loading image preview...")}>
            <TerminalImagePreview
              apiBase={apiBase}
              token={token}
              projectId={projectId}
              path={selectedChangePath}
              refreshKey={0}
              onAuthExpired={onAuthExpired}
            />
          </Suspense>
        );
      } else {
        changeContent = renderPreviewEmpty("Binary file");
      }
    } else if (
      changesViewMode === "preview" &&
      changeDiffFileKind === "markdown" &&
      activeProject
    ) {
      changeContent = (
        <Suspense fallback={renderPreviewEmpty("Loading markdown preview...")}>
          <TerminalMarkdownPreview
            apiBase={apiBase}
            token={token}
            projectId={activeProject.projectId}
            content={fileDiff.newContent}
            path={fileDiff.path}
            onAuthExpired={onAuthExpired}
            onOpenFile={onOpenFilePath}
          />
        </Suspense>
      );
    } else if (changesViewMode === "preview" && changeDiffFileKind === "svg") {
      changeContent = (
        <Suspense fallback={renderPreviewEmpty("Loading SVG preview...")}>
          <TerminalSvgPreview content={fileDiff.newContent} />
        </Suspense>
      );
    } else {
      changeContent = (
        <Suspense fallback={renderPreviewEmpty("Loading editor...")}>
          <TerminalMonacoViewer
            diff
            language={changeDiffMonacoLanguage}
            oldContent={fileDiff.oldContent}
            newContent={fileDiff.newContent}
            lineReferencePath={fileDiff.absolutePath}
          />
        </Suspense>
      );
    }

    return (
      <div
        className="grid h-full min-h-0"
        style={{
          gridTemplateColumns: "auto minmax(0, 1fr)",
        }}
      >
        <TerminalPreviewChangeTree
          changes={changes}
          changesLoading={changesLoading}
          changesError={changesError}
          selectedChangePath={selectedChangePath}
          selectedChangeKind={selectedChangeKind}
          onRequestRenameFile={onRequestRenameFile}
          onRequestDeleteFile={onRequestDeleteFile}
          onSelectChange={onSelectChange}
          onReloadDiff={onReloadDiff}
          onOpenModeFile={onOpenModeFile}
        />
        <div className="min-h-0">{changeContent}</div>
      </div>
    );
  }

  return renderPreviewEmpty(
    "No preview for this project",
    <div className="flex gap-2">
      <Button
        type="button"
        size="sm"
        className="rounded-lg"
        onClick={onOpenModeFile}
      >
        Open file...
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="rounded-lg"
        onClick={onOpenModeChanges}
      >
        Changes
      </Button>
    </div>,
  );
}
