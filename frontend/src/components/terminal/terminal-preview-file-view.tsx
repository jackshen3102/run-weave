import {
  lazy,
  Suspense,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import type {
  TerminalMarkdownViewMode,
  TerminalSvgViewMode,
} from "../../features/terminal/preview-store";
import { getTerminalPreviewMonacoLanguage } from "../../features/terminal/preview-file-types";
import { Button } from "../ui/button";
import { TerminalFileExplorer } from "./terminal-file-explorer";
import { TerminalOpenFileCommand } from "./terminal-open-file-command";
import type { UseTerminalFileTreeReturn } from "./use-terminal-file-tree";

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

export function renderPreviewEmpty(title: string, action?: ReactNode): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-400">
      <p>{title}</p>
      {action}
    </div>
  );
}

interface TerminalPreviewFileViewProps {
  activeProject: TerminalProjectListItem;
  apiBase: string;
  token: string;
  mode: "explorer" | "file";
  projectId: string | null;
  query: string;
  absoluteInput: boolean;
  selectedFilePath?: string;
  fileKind: string;
  markdownViewMode: TerminalMarkdownViewMode;
  markdownSplitSourceWidthPct: number;
  svgViewMode: TerminalSvgViewMode;
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
  fileTree: UseTerminalFileTreeReturn;
  assetRefreshKey: number;
  markdownScrollRatio: number;
  onAuthExpired?: () => void;
  onQueryChange: (nextQuery: string) => void;
  onOpenFilePath: (filePath: string) => void;
  onRequestRenameFile: (filePath: string) => void;
  onRequestDeleteFile: (filePath: string) => void;
  onMarkdownScrollRatioChange: (ratio: number) => void;
  onStartMarkdownResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function TerminalPreviewFileView({
  activeProject,
  apiBase,
  token,
  mode,
  projectId,
  query,
  absoluteInput,
  selectedFilePath,
  fileKind,
  markdownViewMode,
  markdownSplitSourceWidthPct,
  svgViewMode,
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
  fileTree,
  assetRefreshKey,
  markdownScrollRatio,
  onAuthExpired,
  onQueryChange,
  onOpenFilePath,
  onRequestRenameFile,
  onRequestDeleteFile,
  onMarkdownScrollRatioChange,
  onStartMarkdownResize,
}: TerminalPreviewFileViewProps) {
  const monacoLanguage = getTerminalPreviewMonacoLanguage(
    filePreview?.language,
  );
  const sidebar =
    mode === "explorer" ? (
      <TerminalFileExplorer
        tree={fileTree}
        selectedFilePath={selectedFilePath}
        onOpenFilePath={onOpenFilePath}
        onRequestRenameFile={onRequestRenameFile}
        onRequestDeleteFile={onRequestDeleteFile}
      />
    ) : (
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
    );

  let fileContent: ReactNode;

  if (fileKind === "image" && selectedFilePath && projectId) {
    fileContent = (
      <Suspense fallback={renderPreviewEmpty("Loading image preview...")}>
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
    fileContent = renderPreviewEmpty("Loading preview...");
  } else if (fileError) {
    fileContent = renderPreviewEmpty(fileError);
  } else if (filePreview && fileKind === "markdown") {
    fileContent = renderMarkdownContent({
      activeProject,
      apiBase,
      token,
      markdownViewMode,
      markdownSplitSourceWidthPct,
      filePreview,
      editorContent,
      editable,
      onEditorContentChange,
      markdownScrollRatio,
      onMarkdownScrollRatioChange,
      onStartMarkdownResize,
      onAuthExpired,
      onOpenFilePath,
    });
  } else if (filePreview && fileKind === "svg") {
    fileContent =
      svgViewMode === "source" ? (
        <Suspense fallback={renderPreviewEmpty("Loading editor...")}>
          <TerminalMonacoViewer
            language="xml"
            content={editorContent}
            editable={editable}
            onContentChange={onEditorContentChange}
            lineReferencePath={filePreview.absolutePath}
          />
        </Suspense>
      ) : (
        <Suspense fallback={renderPreviewEmpty("Loading SVG preview...")}>
          <TerminalSvgPreview content={editorContent} />
        </Suspense>
      );
  } else if (filePreview) {
    fileContent = (
      <Suspense fallback={renderPreviewEmpty("Loading editor...")}>
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
    fileContent = renderPreviewEmpty("Select a file");
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-slate-800">
        {sidebar}
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

interface RenderMarkdownContentArgs {
  activeProject: TerminalProjectListItem;
  apiBase: string;
  token: string;
  markdownViewMode: TerminalMarkdownViewMode;
  markdownSplitSourceWidthPct: number;
  filePreview: TerminalPreviewFileResponse;
  editorContent: string;
  editable: boolean;
  onEditorContentChange: (content: string) => void;
  markdownScrollRatio: number;
  onMarkdownScrollRatioChange: (ratio: number) => void;
  onStartMarkdownResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onAuthExpired?: () => void;
  onOpenFilePath: (filePath: string) => void;
}

function renderMarkdownContent({
  activeProject,
  apiBase,
  token,
  markdownViewMode,
  markdownSplitSourceWidthPct,
  filePreview,
  editorContent,
  editable,
  onEditorContentChange,
  markdownScrollRatio,
  onMarkdownScrollRatioChange,
  onStartMarkdownResize,
  onAuthExpired,
  onOpenFilePath,
}: RenderMarkdownContentArgs): ReactNode {
  if (markdownViewMode === "source") {
    return (
      <Suspense fallback={renderPreviewEmpty("Loading editor...")}>
        <TerminalMonacoViewer
          language="markdown"
          content={editorContent}
          editable={editable}
          onContentChange={onEditorContentChange}
          lineReferencePath={filePreview.absolutePath}
        />
      </Suspense>
    );
  }

  if (markdownViewMode === "preview") {
    return (
      <Suspense fallback={renderPreviewEmpty("Loading markdown preview...")}>
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
    );
  }

  return (
    <div
      className="grid h-full min-h-0"
      style={{
        gridTemplateColumns: `${markdownSplitSourceWidthPct}% 4px minmax(0, 1fr)`,
      }}
    >
      <Suspense fallback={renderPreviewEmpty("Loading editor...")}>
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
      <Suspense fallback={renderPreviewEmpty("Loading markdown preview...")}>
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
}

export {
  TerminalMarkdownPreview,
  TerminalMonacoViewer,
  TerminalSvgPreview,
  TerminalImagePreview,
};
