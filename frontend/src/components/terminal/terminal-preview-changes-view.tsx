import { Suspense, type ReactNode } from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewGitChangesResponse,
} from "@runweave/shared/terminal/preview";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalChangesViewMode } from "../../features/terminal/preview-store";
import {
  extensionToLanguageHint,
  getTerminalPreviewFileKind,
  getTerminalPreviewMonacoLanguage,
} from "../../features/terminal/preview-file-types";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { TerminalPreviewChangeTree } from "./terminal-preview-change-tree";
import {
  renderPreviewEmpty,
  TerminalImagePreview,
  TerminalMarkdownPreview,
  TerminalMonacoViewer,
  TerminalSvgPreview,
} from "./terminal-preview-file-view";

interface ChangesQueryState {
  data: TerminalPreviewGitChangesResponse | null;
  error: string | null;
  loading: boolean;
}

interface DiffQueryState {
  data: TerminalPreviewFileDiffResponse | null;
  error: string | null;
  loading: boolean;
}

interface ChangesSelection {
  kind?: TerminalPreviewChangeKind;
  path?: string;
  viewMode: TerminalChangesViewMode;
}

interface ChangesCommands {
  openFile: (path: string) => void;
  openFileMode: () => void;
  reloadDiff: (path: string, kind: TerminalPreviewChangeKind) => void;
  requestDelete: (path: string) => void;
  requestRename: (path: string) => void;
  requestReset: (path: string, kind: TerminalPreviewChangeKind) => void;
  select: (path: string, kind: TerminalPreviewChangeKind) => void;
}

interface TerminalPreviewChangesViewProps {
  activeProject: TerminalProjectListItem;
  changes: ChangesQueryState;
  commands: ChangesCommands;
  diff: DiffQueryState;
  selection: ChangesSelection;
}

export function TerminalPreviewChangesView({
  activeProject,
  changes,
  commands,
  diff,
  selection,
}: TerminalPreviewChangesViewProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
  const fileDiffMatchesSelection =
    diff.data !== null &&
    diff.data.path === selection.path &&
    diff.data.changeKind === selection.kind;
  const selectedChangePending =
    Boolean(selection.path && selection.kind) && !fileDiffMatchesSelection;
  const showDiffLoading = diff.loading || selectedChangePending;

  const renderFileDiffContent = (
    currentFileDiff: TerminalPreviewFileDiffResponse,
    displayPath: string,
  ): ReactNode => {
    const fileKind = getTerminalPreviewFileKind(displayPath, null);
    if (fileKind === "image" && currentFileDiff.status === "deleted") {
      return renderPreviewEmpty("Image deleted");
    }
    if (fileKind === "image") {
      return (
        <Suspense fallback={renderPreviewEmpty("Loading image preview...")}>
          <TerminalImagePreview
            apiBase={apiBase}
            token={token}
            projectId={activeProject.projectId}
            path={displayPath}
            refreshKey={0}
            onAuthExpired={onAuthExpired}
          />
        </Suspense>
      );
    }
    if (selection.viewMode === "preview" && fileKind === "markdown") {
      return (
        <Suspense fallback={renderPreviewEmpty("Loading markdown preview...")}>
          <TerminalMarkdownPreview
            apiBase={apiBase}
            token={token}
            projectId={activeProject.projectId}
            content={currentFileDiff.newContent}
            path={currentFileDiff.path}
            onAuthExpired={onAuthExpired}
            onOpenFile={commands.openFile}
          />
        </Suspense>
      );
    }
    if (selection.viewMode === "preview" && fileKind === "svg") {
      return (
        <Suspense fallback={renderPreviewEmpty("Loading SVG preview...")}>
          <TerminalSvgPreview content={currentFileDiff.newContent} />
        </Suspense>
      );
    }
    return (
      <Suspense fallback={renderPreviewEmpty("Loading editor...")}>
        <TerminalMonacoViewer
          diff
          language={getTerminalPreviewMonacoLanguage(
            extensionToLanguageHint(displayPath),
          )}
          oldContent={currentFileDiff.oldContent}
          newContent={currentFileDiff.newContent}
          lineReferencePath={currentFileDiff.absolutePath}
        />
      </Suspense>
    );
  };

  let content: ReactNode;
  if (diff.error && !showDiffLoading) {
    content = renderPreviewEmpty(diff.error);
  } else if (showDiffLoading && diff.data) {
    content = (
      <div className="relative h-full min-h-0 overflow-hidden">
        <div className="h-full min-h-0 opacity-45 transition-opacity duration-150 ease-out">
          {renderFileDiffContent(diff.data, diff.data.path)}
        </div>
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/30 backdrop-blur-[1px]">
          <div className="rounded-md border border-slate-700/70 bg-slate-950/80 px-3 py-1.5 text-xs text-slate-300 shadow-lg shadow-slate-950/30">
            Loading diff...
          </div>
        </div>
      </div>
    );
  } else if (showDiffLoading) {
    content = renderPreviewEmpty("Loading diff...");
  } else if (!diff.data) {
    content = renderPreviewEmpty("Select a changed file");
  } else {
    content = renderFileDiffContent(diff.data, diff.data.path);
  }

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}
    >
      <TerminalPreviewChangeTree
        changes={changes.data}
        changesLoading={changes.loading}
        changesError={changes.error}
        selectedChangePath={selection.path}
        selectedChangeKind={selection.kind}
        onRequestRenameFile={commands.requestRename}
        onRequestDeleteFile={commands.requestDelete}
        onRequestResetChange={commands.requestReset}
        onSelectChange={commands.select}
        onReloadDiff={commands.reloadDiff}
        onOpenModeFile={commands.openFileMode}
      />
      <div className="min-h-0">{content}</div>
    </div>
  );
}
