import {
  lazy,
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
import { TerminalOpenFileCommand } from "./terminal-open-file-command";
import { TerminalPreviewChangeTree } from "./terminal-preview-change-tree";

const TerminalMonacoViewer = lazy(() =>
  import("./terminal-monaco-viewer").then((module) => ({
    default: module.TerminalMonacoViewer,
  })),
);

const TerminalMarkdownPreview = lazy(() =>
  import("./terminal-markdown-preview").then((module) => ({
    default: module.TerminalMarkdownPreview,
  })),
);

const TerminalSvgPreview = lazy(() =>
  import("./terminal-svg-preview").then((module) => ({
    default: module.TerminalSvgPreview,
  })),
);

const TerminalImagePreview = lazy(() =>
  import("./terminal-image-preview").then((module) => ({
    default: module.TerminalImagePreview,
  })),
);

function renderEmpty(title: string, action?: ReactNode): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-400">
      <p>{title}</p>
      {action}
    </div>
  );
}

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
    return renderEmpty("No project selected");
  }

  if (!hasProjectPath) {
    return renderEmpty(
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

  if (mode === "file") {
    const monacoLanguage = getTerminalPreviewMonacoLanguage(
      filePreview?.language,
    );
    let fileContent: ReactNode;

    if (fileKind === "image" && selectedFilePath && projectId) {
      fileContent = (
        <Suspense fallback={renderEmpty("Loading image preview...")}>
          <TerminalImagePreview
            apiBase={apiBase}
            token={token}
            projectId={projectId}
            path={selectedFilePath}
            refreshKey={assetRefreshKey}
            onAuthExpired={onAuthExpired}
          />
        </Suspense>
      );
    } else if (fileLoading) {
      fileContent = renderEmpty("Loading preview...");
    } else if (fileError) {
      fileContent = renderEmpty(fileError);
    } else if (filePreview && fileKind === "markdown") {
      fileContent =
        markdownViewMode === "source" ? (
          <Suspense fallback={renderEmpty("Loading editor...")}>
            <TerminalMonacoViewer
              language="markdown"
              content={editorContent}
              editable={editable}
              onContentChange={onEditorContentChange}
              lineReferencePath={filePreview.absolutePath}
            />
          </Suspense>
        ) : markdownViewMode === "preview" ? (
          <Suspense fallback={renderEmpty("Loading markdown preview...")}>
            <TerminalMarkdownPreview
              apiBase={apiBase}
              token={token}
              projectId={activeProject.projectId}
              content={editorContent}
              path={filePreview.path}
              onAuthExpired={onAuthExpired}
              onOpenFile={onOpenFilePath}
            />
          </Suspense>
        ) : (
          <div
            className="grid h-full min-h-0"
            style={{
              gridTemplateColumns: `${markdownSplitSourceWidthPct}% 4px minmax(0, 1fr)`,
            }}
          >
            <Suspense fallback={renderEmpty("Loading editor...")}>
              <TerminalMonacoViewer
                language="markdown"
                content={editorContent}
                scrollRatio={markdownScrollRatio}
                onScrollRatioChange={onMarkdownScrollRatioChange}
                editable={editable}
                onContentChange={onEditorContentChange}
                lineReferencePath={filePreview.absolutePath}
              />
            </Suspense>
            <div
              role="separator"
              aria-orientation="vertical"
              className="cursor-col-resize bg-slate-900 hover:bg-slate-700"
              onPointerDown={onStartMarkdownResize}
            />
            <Suspense fallback={renderEmpty("Loading markdown preview...")}>
              <TerminalMarkdownPreview
                apiBase={apiBase}
                token={token}
                projectId={activeProject.projectId}
                content={editorContent}
                path={filePreview.path}
                scrollRatio={markdownScrollRatio}
                onScrollRatioChange={onMarkdownScrollRatioChange}
                onAuthExpired={onAuthExpired}
                onOpenFile={onOpenFilePath}
              />
            </Suspense>
          </div>
        );
    } else if (filePreview && fileKind === "svg") {
      fileContent =
        svgViewMode === "source" ? (
          <Suspense fallback={renderEmpty("Loading editor...")}>
            <TerminalMonacoViewer
              language="xml"
              content={editorContent}
              editable={editable}
              onContentChange={onEditorContentChange}
              lineReferencePath={filePreview.absolutePath}
            />
          </Suspense>
        ) : (
          <Suspense fallback={renderEmpty("Loading SVG preview...")}>
            <TerminalSvgPreview content={editorContent} />
          </Suspense>
        );
    } else if (filePreview) {
      fileContent = (
        <Suspense fallback={renderEmpty("Loading editor...")}>
          <TerminalMonacoViewer
            language={monacoLanguage}
            content={editorContent}
            editable={editable}
            onContentChange={onEditorContentChange}
            lineReferencePath={filePreview.absolutePath}
          />
        </Suspense>
      );
    } else {
      fileContent = renderEmpty("Select a file");
    }

    return (
      <div className="grid h-full min-h-0 grid-cols-[180px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-slate-800">
          <TerminalOpenFileCommand
            query={query}
            loading={searchLoading}
            error={searchError}
            items={searchItems}
            absoluteInput={absoluteInput}
            selectedPath={selectedFilePath}
            className="flex h-full min-h-0 flex-col bg-slate-950"
            onQueryChange={onQueryChange}
            onOpenPath={onOpenFilePath}
            onRequestRenameFile={onRequestRenameFile}
            onRequestDeleteFile={onRequestDeleteFile}
          />
        </aside>
        <div className="relative min-h-0">
          {saveError ? (
            <div className="absolute left-2 right-2 top-2 z-10 rounded-md border border-rose-900/70 bg-rose-950/95 p-2 text-xs text-rose-100 shadow-lg">
              <div>{saveError}</div>
              {saveConflict ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-md px-2 text-xs"
                    onClick={onReloadFile}
                  >
                    Reload
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-md px-2 text-xs"
                    onClick={onOverwriteFile}
                  >
                    Overwrite
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {fileContent}
        </div>
      </div>
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
      changeContent = renderEmpty("Loading diff...");
    } else if (diffError) {
      changeContent = renderEmpty(diffError);
    } else if (!fileDiff) {
      changeContent = renderEmpty("Select a changed file");
    } else if (changeDiffFileKind === "image") {
      if (isChangeImageDeleted) {
        changeContent = renderEmpty("Image deleted");
      } else if (selectedChangePath && projectId) {
        changeContent = (
          <Suspense fallback={renderEmpty("Loading image preview...")}>
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
        changeContent = renderEmpty("Binary file");
      }
    } else if (
      changesViewMode === "preview" &&
      changeDiffFileKind === "markdown" &&
      activeProject
    ) {
      changeContent = (
        <Suspense fallback={renderEmpty("Loading markdown preview...")}>
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
        <Suspense fallback={renderEmpty("Loading SVG preview...")}>
          <TerminalSvgPreview content={fileDiff.newContent} />
        </Suspense>
      );
    } else {
      changeContent = (
        <Suspense fallback={renderEmpty("Loading editor...")}>
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

  return renderEmpty(
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
