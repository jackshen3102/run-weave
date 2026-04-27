import { lazy, Suspense, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type {
  TerminalPreviewChangeFile,
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
  onSelectChange: (filePath: string, kind: TerminalPreviewChangeKind) => void;
  onReloadDiff: (filePath: string, kind: TerminalPreviewChangeKind) => void;
  onMarkdownScrollRatioChange: (ratio: number) => void;
  onStartMarkdownResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenModeFile: () => void;
  onOpenModeChanges: () => void;
}

function renderEmpty(title: string, action?: ReactNode): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-400">
      <p>{title}</p>
      {action}
    </div>
  );
}

function statusBadge(status: TerminalPreviewChangeFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "modified":
      return "M";
    default:
      return "?";
  }
}

function basename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function dirname(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
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

  const renderChangesList = (
    title: string,
    kind: TerminalPreviewChangeKind,
    files: TerminalPreviewChangeFile[],
  ): ReactNode => (
    <div className="flex flex-col gap-1">
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-500">
        {title}
      </div>
      {files.map((file) => {
        const selected =
          selectedChangePath === file.path && selectedChangeKind === kind;
        return (
          <button
            type="button"
            key={`${kind}:${file.path}`}
            className={[
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
              selected
                ? "bg-slate-800 text-slate-100"
                : "text-slate-300 hover:bg-slate-900",
            ].join(" ")}
            onClick={() => {
              if (selected) {
                onReloadDiff(file.path, kind);
                return;
              }
              onSelectChange(file.path, kind);
            }}
          >
            <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400">
              {statusBadge(file.status)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{basename(file.path)}</span>
              {dirname(file.path) ? (
                <span className="block truncate text-[11px] text-slate-500">
                  {dirname(file.path)}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );

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
    const monacoLanguage = getTerminalPreviewMonacoLanguage(filePreview?.language);
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
            <TerminalMonacoViewer language="markdown" content={filePreview.content} />
          </Suspense>
        ) : markdownViewMode === "preview" ? (
          <Suspense fallback={renderEmpty("Loading markdown preview...")}>
            <TerminalMarkdownPreview
              apiBase={apiBase}
              token={token}
              projectId={activeProject.projectId}
              content={filePreview.content}
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
                content={filePreview.content}
                scrollRatio={markdownScrollRatio}
                onScrollRatioChange={onMarkdownScrollRatioChange}
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
                content={filePreview.content}
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
            <TerminalMonacoViewer language="xml" content={filePreview.content} />
          </Suspense>
        ) : (
          <Suspense fallback={renderEmpty("Loading SVG preview...")}>
            <TerminalSvgPreview content={filePreview.content} />
          </Suspense>
        );
    } else if (filePreview) {
      fileContent = (
        <Suspense fallback={renderEmpty("Loading editor...")}>
          <TerminalMonacoViewer language={monacoLanguage} content={filePreview.content} />
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
          />
        </aside>
        <div className="min-h-0">{fileContent}</div>
      </div>
    );
  }

  if (mode === "changes") {
    const noChanges =
      changes && changes.staged.length === 0 && changes.working.length === 0;
    const changeDiffFileKind = selectedChangePath
      ? getTerminalPreviewFileKind(selectedChangePath, null)
      : "text";
    const changeDiffLanguageHint = selectedChangePath
      ? extensionToLanguageHint(selectedChangePath)
      : null;
    const changeDiffMonacoLanguage = getTerminalPreviewMonacoLanguage(changeDiffLanguageHint);
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
          />
        </Suspense>
      );
    }

    return (
      <div className="grid h-full min-h-0 grid-cols-[180px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-r border-slate-800 p-1.5">
          {changesLoading && !changes ? (
            <div className="px-2 py-3 text-xs text-slate-400">Loading changes...</div>
          ) : changesError ? (
            <div className="px-2 py-3 text-xs text-rose-300">{changesError}</div>
          ) : noChanges ? (
            <div className="flex flex-col gap-2 px-2 py-3 text-xs text-slate-400">
              <span>No changes</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 justify-start rounded-md px-2 text-xs"
                onClick={onOpenModeFile}
              >
                Browse files
              </Button>
            </div>
          ) : changes ? (
            <div className="flex flex-col gap-2">
              {renderChangesList("Staged Changes", "staged", changes.staged)}
              {renderChangesList("Working Changes", "working", changes.working)}
            </div>
          ) : null}
        </aside>
        <div className="min-h-0">{changeContent}</div>
      </div>
    );
  }

  return renderEmpty(
    "No preview for this project",
    <div className="flex gap-2">
      <Button type="button" size="sm" className="rounded-lg" onClick={onOpenModeFile}>
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
