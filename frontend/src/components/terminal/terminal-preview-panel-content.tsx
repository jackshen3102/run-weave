import {
  lazy,
  Suspense,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  PanelLeftOpen,
} from "lucide-react";
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

interface ChangeTreeFileNode {
  type: "file";
  name: string;
  path: string;
  file: TerminalPreviewChangeFile;
}

interface ChangeTreeDirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: ChangeTreeNode[];
}

type ChangeTreeNode = ChangeTreeFileNode | ChangeTreeDirectoryNode;

interface MutableChangeTreeDirectory {
  type: "directory";
  name: string;
  path: string;
  children: Map<string, MutableChangeTreeNode>;
}

type MutableChangeTreeNode = MutableChangeTreeDirectory | ChangeTreeFileNode;

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

function compactDirectory(node: ChangeTreeDirectoryNode): ChangeTreeDirectoryNode {
  let current = node;
  while (
    current.children.length === 1 &&
    current.children[0]?.type === "directory"
  ) {
    const child = current.children[0];
    current = {
      type: "directory",
      name: `${current.name}/${child.name}`,
      path: child.path,
      children: child.children,
    };
  }
  return current;
}

function sortChangeTreeNodes(nodes: ChangeTreeNode[]): ChangeTreeNode[] {
  return [...nodes].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function convertChangeTreeNode(node: MutableChangeTreeNode): ChangeTreeNode {
  if (node.type === "file") {
    return node;
  }

  const children = sortChangeTreeNodes(
    [...node.children.values()].map(convertChangeTreeNode),
  );
  return compactDirectory({
    type: "directory",
    name: node.name,
    path: node.path,
    children,
  });
}

function buildChangeTree(files: TerminalPreviewChangeFile[]): ChangeTreeNode[] {
  const root: MutableChangeTreeDirectory = {
    type: "directory",
    name: "",
    path: "",
    children: new Map(),
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let directory = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!;
      const path = parts.slice(0, index + 1).join("/");
      const directoryKey = `${name}/`;
      const existing = directory.children.get(directoryKey);
      if (existing?.type === "directory") {
        directory = existing;
        continue;
      }

      const nextDirectory: MutableChangeTreeDirectory = {
        type: "directory",
        name,
        path,
        children: new Map(),
      };
      directory.children.set(directoryKey, nextDirectory);
      directory = nextDirectory;
    }

    const name = parts.at(-1)!;
    directory.children.set(name, {
      type: "file",
      name,
      path: file.path,
      file,
    });
  }

  return sortChangeTreeNodes([...root.children.values()].map(convertChangeTreeNode));
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
  const [collapsedChangeTree, setCollapsedChangeTree] = useState(false);
  const [collapsedChangeDirectories, setCollapsedChangeDirectories] = useState<
    Record<string, boolean>
  >({});
  const fileKind = selectedFilePath
    ? getTerminalPreviewFileKind(selectedFilePath, filePreview?.language)
    : "text";

  const stagedChangeTree = useMemo(
    () => buildChangeTree(changes?.staged ?? []),
    [changes?.staged],
  );
  const workingChangeTree = useMemo(
    () => buildChangeTree(changes?.working ?? []),
    [changes?.working],
  );

  const renderChangeTreeNodes = (
    kind: TerminalPreviewChangeKind,
    nodes: ChangeTreeNode[],
    depth = 0,
  ): ReactNode =>
    nodes.map((node) => {
      if (node.type === "directory") {
        const collapseKey = `${kind}:${node.path}`;
        const collapsed = collapsedChangeDirectories[collapseKey] === true;
        return (
          <div key={`${kind}:dir:${node.path}`}>
            <button
              type="button"
              aria-expanded={!collapsed}
              className="group flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-[11px] text-slate-400 hover:bg-slate-900 hover:text-slate-200 focus-visible:bg-slate-900 focus-visible:text-slate-200 focus-visible:outline-none"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => {
                setCollapsedChangeDirectories((current) => ({
                  ...current,
                  [collapseKey]: !collapsed,
                }));
              }}
            >
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              )}
              <Folder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </button>
            {collapsed ? null : renderChangeTreeNodes(kind, node.children, depth + 1)}
          </div>
        );
      }

      const selected =
        selectedChangePath === node.file.path && selectedChangeKind === kind;
      return (
        <button
          type="button"
          key={`${kind}:file:${node.file.path}`}
          className={[
            "flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-xs",
            selected
              ? "bg-slate-800 text-slate-100"
              : "text-slate-300 hover:bg-slate-900",
          ].join(" ")}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={node.file.path}
          onClick={() => {
            if (selected) {
              onReloadDiff(node.file.path, kind);
              return;
            }
            onSelectChange(node.file.path, kind);
          }}
        >
          <span className="w-3.5 shrink-0 text-center text-[9px] text-slate-500">
            {statusBadge(node.file.status)}
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
      );
    });

  const renderChangesTreeSection = (
    title: string,
    kind: TerminalPreviewChangeKind,
    files: TerminalPreviewChangeFile[],
    nodes: ChangeTreeNode[],
  ): ReactNode => {
    if (files.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-col">
        <div className="flex h-7 items-center justify-between px-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
          <span>{title}</span>
          <span className="tracking-normal">{files.length}</span>
        </div>
        {renderChangeTreeNodes(kind, nodes)}
      </div>
    );
  };

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
      <div
        className="grid h-full min-h-0"
        style={{
          gridTemplateColumns: collapsedChangeTree
            ? "32px minmax(0, 1fr)"
            : "220px minmax(0, 1fr)",
        }}
      >
        <aside className="group relative min-h-0 overflow-auto border-r border-slate-800">
          <button
            type="button"
            className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-slate-950/90 text-slate-500 opacity-0 transition-opacity hover:bg-slate-900 hover:text-slate-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
            aria-label={collapsedChangeTree ? "Show changes tree" : "Hide changes tree"}
            onClick={() => setCollapsedChangeTree((current) => !current)}
          >
            {collapsedChangeTree ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
          {collapsedChangeTree ? (
            <button
              type="button"
              className="flex h-full w-full items-start justify-center px-1.5 pt-9 text-[10px] uppercase tracking-[0.16em] text-slate-600 hover:text-slate-300 focus-visible:text-slate-300 focus-visible:outline-none"
              aria-label="Show changes tree"
              onClick={() => setCollapsedChangeTree(false)}
            >
              <span className="[writing-mode:vertical-rl]">Changes</span>
            </button>
          ) : changesLoading && !changes ? (
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
            <div className="flex flex-col gap-1 p-1.5 pt-7">
              {renderChangesTreeSection(
                "Staged",
                "staged",
                changes.staged,
                stagedChangeTree,
              )}
              {renderChangesTreeSection(
                "Working",
                "working",
                changes.working,
                workingChangeTree,
              )}
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
