import {
  lazy,
  Suspense,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import type {
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
} from "@runweave/shared/terminal/preview";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type {
  TerminalMarkdownViewMode,
  TerminalSvgViewMode,
} from "../../features/terminal/preview-store";
import { getTerminalPreviewMonacoLanguage } from "../../features/terminal/preview-file-types";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { Button } from "../ui/button";
import { TerminalFileExplorer } from "./terminal-file-explorer";
import { TerminalOpenFileCommand } from "./terminal-open-file-command";
import type { UseTerminalFileTreeReturn } from "./use-terminal-file-tree";

export interface TerminalPreviewLineTarget {
  path: string;
  line: number;
  column: number;
  key: string;
}

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

export function renderPreviewEmpty(
  title: string,
  action?: ReactNode,
): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-400">
      <p>{title}</p>
      {action}
    </div>
  );
}

interface PreviewFileNavigation {
  mode: "explorer" | "file";
  query: string;
  absoluteInput: boolean;
  selectedFilePath?: string;
  searchItems: TerminalPreviewFileSearchItem[];
  searchLoading: boolean;
  searchError: string | null;
  onQueryChange: (nextQuery: string) => void;
  onOpenFilePath: (filePath: string) => void;
  onOpenQuickSearch: () => void;
  onRequestRenameFile: (filePath: string) => void;
  onRequestDeleteFile: (filePath: string) => void;
}

interface PreviewFileResource {
  data: TerminalPreviewFileResponse | null;
  kind: string;
  loading: boolean;
  error: string | null;
  assetRefreshKey: number;
}

interface PreviewFileEditor {
  content: string;
  editable: boolean;
  saveError: string | null;
  saveConflict: boolean;
  onContentChange: (content: string) => void;
  onReload: () => void;
  onOverwrite: () => void;
}

interface PreviewFileDisplay {
  markdownViewMode: TerminalMarkdownViewMode;
  markdownSplitSourceWidthPct: number;
  svgViewMode: TerminalSvgViewMode;
  markdownScrollRatio: number;
  lineTarget: TerminalPreviewLineTarget | null;
  onMarkdownScrollRatioChange: (ratio: number) => void;
  onStartMarkdownResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

interface TerminalPreviewFileViewProps {
  activeProject: TerminalProjectListItem;
  display: PreviewFileDisplay;
  editor: PreviewFileEditor;
  file: PreviewFileResource;
  fileTree: UseTerminalFileTreeReturn;
  navigation: PreviewFileNavigation;
}

export function TerminalPreviewFileView({
  activeProject,
  display,
  editor,
  file,
  fileTree,
  navigation,
}: TerminalPreviewFileViewProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
  const projectId = activeProject.projectId;
  const {
    absoluteInput,
    mode,
    query,
    searchError,
    searchItems,
    searchLoading,
    selectedFilePath,
    onOpenFilePath,
    onOpenQuickSearch,
    onQueryChange,
    onRequestDeleteFile,
    onRequestRenameFile,
  } = navigation;
  const {
    assetRefreshKey,
    data: filePreview,
    error: fileError,
    kind: fileKind,
    loading: fileLoading,
  } = file;
  const {
    content: editorContent,
    editable,
    saveConflict,
    saveError,
    onContentChange: onEditorContentChange,
    onOverwrite: onOverwriteFile,
    onReload: onReloadFile,
  } = editor;
  const {
    lineTarget,
    markdownScrollRatio,
    markdownSplitSourceWidthPct,
    markdownViewMode,
    svgViewMode,
    onMarkdownScrollRatioChange,
    onStartMarkdownResize,
  } = display;
  const monacoLanguage = getTerminalPreviewMonacoLanguage(
    filePreview?.language,
  );
  const revealPosition =
    lineTarget && lineTarget.path === selectedFilePath
      ? {
          line: lineTarget.line,
          column: lineTarget.column,
          key: lineTarget.key,
        }
      : undefined;
  const sidebar =
    mode === "explorer" ? (
      <>
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-800 px-3">
          <span className="text-xs font-medium text-slate-300">
            Project Files
          </span>
          <button
            type="button"
            aria-label="Search project files"
            title="Search project files"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500"
            onClick={onOpenQuickSearch}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        </div>
        <TerminalFileExplorer
          tree={fileTree}
          selectedFilePath={selectedFilePath}
          onOpenFilePath={onOpenFilePath}
          onRequestRenameFile={onRequestRenameFile}
          onRequestDeleteFile={onRequestDeleteFile}
        />
      </>
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
      initialRevealPosition: revealPosition,
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
            initialRevealPosition={revealPosition}
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
          initialRevealPosition={revealPosition}
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
  initialRevealPosition?: {
    line: number;
    column: number;
    key: string;
  };
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
  initialRevealPosition,
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
          initialRevealPosition={initialRevealPosition}
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
          initialRevealPosition={initialRevealPosition}
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
