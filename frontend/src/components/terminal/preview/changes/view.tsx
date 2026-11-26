import { useMemoizedFn } from "ahooks";
import { Suspense, type ReactNode } from "react";
import type {
  TerminalPreviewBranchChangesResponse,
  TerminalPreviewBranchCommitsResponse,
  TerminalPreviewChangeKind,
  TerminalPreviewChangeScope,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewWritableChangeKind,
} from "@runweave/shared/terminal/preview";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalChangesViewMode } from "../../../../features/terminal/preview/store";
import {
  extensionToLanguageHint,
  getTerminalPreviewFileKind,
  getTerminalPreviewMonacoLanguage,
} from "../../../../features/terminal/preview/file-types";
import { useTerminalRuntime } from "../../../../features/terminal/queries/provider";
import { TerminalPreviewChangeTree } from "./tree";
import {
  renderPreviewEmpty,
  TerminalImagePreview,
  TerminalMarkdownPreview,
  TerminalMonacoViewer,
  type TerminalPreviewLineTarget,
  TerminalSvgPreview,
} from "../files/view";
import { TerminalHtmlPreview } from "../renderers/html";

const ignoreContentChange = () => {};

interface ChangesQueryState {
  data: TerminalPreviewGitChangesResponse | null;
  error: string | null;
  loading: boolean;
}

interface BranchChangesQueryState {
  data: TerminalPreviewBranchChangesResponse | null;
  error: string | null;
  loading: boolean;
}

interface BranchCommitsQueryState {
  data: TerminalPreviewBranchCommitsResponse | null;
  error: string | null;
  loading: boolean;
}

interface DiffQueryState {
  data: TerminalPreviewFileDiffResponse | null;
  error: string | null;
  loading: boolean;
}

interface ChangesSelection {
  scope: TerminalPreviewChangeScope;
  kind?: TerminalPreviewChangeKind;
  path?: string;
  baseOid?: string;
  commitOid?: string;
  viewMode: TerminalChangesViewMode;
}

interface ChangesMarkdownReference {
  canInsert: boolean;
  disabledReason?: string;
  lineTarget: TerminalPreviewLineTarget | null;
  insert: (reference: string) => void;
  setTarget: (
    path: string,
    target?: { line: number; column: number },
  ) => void;
}

interface ChangesCommands {
  openFile: (path: string) => void;
  openFileMode: () => void;
  reloadDiff: (path: string, kind: TerminalPreviewChangeKind) => void;
  requestDelete: (path: string) => void;
  requestRename: (path: string) => void;
  requestReset: (path: string, kind: TerminalPreviewWritableChangeKind) => void;
  select: (path: string, kind: TerminalPreviewChangeKind) => void;
  selectScope: (scope: TerminalPreviewChangeScope) => void;
  selectCommit: (commitOid: string) => void;
  setViewMode: (mode: TerminalChangesViewMode) => void;
}

interface TerminalPreviewChangesViewProps {
  activeProject: TerminalProjectListItem;
  changes: ChangesQueryState;
  branchChanges: BranchChangesQueryState;
  branchCommits: BranchCommitsQueryState;
  commands: ChangesCommands;
  diff: DiffQueryState;
  markdownReference: ChangesMarkdownReference;
  selection: ChangesSelection;
}

export function TerminalPreviewChangesView({
  activeProject,
  changes,
  branchChanges,
  branchCommits,
  commands,
  diff,
  markdownReference,
  selection,
}: TerminalPreviewChangesViewProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
  const fileDiffMatchesSelection =
    diff.data !== null &&
    diff.data.path === selection.path &&
    diff.data.changeKind === selection.kind &&
    (selection.kind !== "branch" || diff.data.baseOid === selection.baseOid) &&
    (selection.kind !== "commit" || diff.data.commitOid === selection.commitOid);
  const selectedChangePending =
    Boolean(selection.path && selection.kind) && !fileDiffMatchesSelection;
  const showDiffLoading = diff.loading || (selectedChangePending && !diff.error);
  const revealMarkdownSourceLine = useMemoizedFn((line: number): void => {
    if (diff.data) {
      markdownReference.setTarget(diff.data.path, { line, column: 1 });
      commands.setViewMode("diff");
    }
  });

  const renderFileDiffContent = (
    currentFileDiff: TerminalPreviewFileDiffResponse,
    displayPath: string,
  ): ReactNode => {
    const fileKind = getTerminalPreviewFileKind(displayPath, null);
    const side = currentFileDiff.status === "deleted" ? currentFileDiff.oldSide : currentFileDiff.newSide;
    const isImage = currentFileDiff.contentKind === "image" || (!currentFileDiff.contentKind && fileKind === "image");
    const problem = isImage ? side : [currentFileDiff.newSide, currentFileDiff.oldSide]
      .find((value) => value && !["ready", "missing"].includes(value.state));
    if (problem && !["ready", "missing"].includes(problem.state)) {
      const message = problem.state === "too-large" ? "文件太大，无法预览"
        : problem.state === "read-failed" ? "读取文件失败，请重试" : "此文件不支持内容预览";
      return <div className="p-6 text-sm text-slate-400">
        <p>{message}</p><p>{displayPath}{problem.sizeBytes !== undefined ? ` · ${problem.sizeBytes} bytes` : ""}</p>
        <button className="mt-3 underline" onClick={() => commands.reloadDiff(currentFileDiff.path, currentFileDiff.changeKind)}>重新加载</button>
      </div>;
    }
    if (isImage) {
      if (!side && currentFileDiff.status === "deleted") return renderPreviewEmpty("服务器尚不支持已删除图片的版本预览");
      const label =
        side?.source === "index"
          ? "暂存版本"
          : side?.source === "head"
            ? "已提交版本"
            : side?.source === "merge-base"
              ? "主分支共同祖先版本"
              : side?.source === "commit-parent"
                ? "提交前版本"
                : side?.source === "commit"
                  ? "该提交版本"
                  : "工作区版本";
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="px-3 py-1 text-xs text-slate-400">
            {currentFileDiff.status === "deleted" ? "已删除 · 删除前版本 · " : ""}{label}
            {!side ? "（服务器尚不支持 Git 图片版本）" : ""}
            {currentFileDiff.oldPath ? ` · 重命名自 ${currentFileDiff.oldPath}` : ""}
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={renderPreviewEmpty("Loading image preview...")}>
              <TerminalImagePreview
                key={`${currentFileDiff.changeKind}:${currentFileDiff.baseOid ?? currentFileDiff.commitOid ?? ""}:${displayPath}:${side?.version ?? "legacy"}`}
                apiBase={apiBase} token={token} projectId={activeProject.projectId}
                path={displayPath} refreshKey={0} onAuthExpired={onAuthExpired}
                change={side?.version ? {
                  kind: currentFileDiff.changeKind,
                  side: currentFileDiff.status === "deleted" ? "old" : "new",
                  version: side.version,
                  baseOid: currentFileDiff.baseOid,
                  commitOid: currentFileDiff.commitOid,
                } : undefined}
                onReload={() => commands.reloadDiff(currentFileDiff.path, currentFileDiff.changeKind)}
              />
            </Suspense>
          </div>
        </div>
      );
    }
    if ((currentFileDiff.diffState === "unchanged" && (selection.viewMode !== "preview" || !["markdown", "svg", "html"].includes(fileKind))) || (!currentFileDiff.oldContent && !currentFileDiff.newContent)) {
      return renderPreviewEmpty(`${currentFileDiff.oldPath ? `重命名自 ${currentFileDiff.oldPath} · ` : ""}${currentFileDiff.newContent || currentFileDiff.oldContent ? "无文本内容变化" : "文件为空"}`);
    }
    const previewContent = currentFileDiff.status === "deleted" ? currentFileDiff.oldContent : currentFileDiff.newContent;
    if (selection.viewMode === "preview" && fileKind === "markdown") {
      return (
        <Suspense fallback={renderPreviewEmpty("Loading markdown preview...")}>
          <TerminalMarkdownPreview
            apiBase={apiBase}
            token={token}
            projectId={activeProject.projectId}
            content={previewContent}
            path={currentFileDiff.path}
            lineReferencePath={currentFileDiff.absolutePath}
            canInsertLineReference={markdownReference.canInsert}
            lineReferenceDisabledReason={markdownReference.disabledReason}
            onAuthExpired={onAuthExpired}
            onOpenFile={commands.openFile}
            onInsertLineReference={markdownReference.insert}
            onRevealSourceLine={revealMarkdownSourceLine}
          />
        </Suspense>
      );
    }
    if (selection.viewMode === "preview" && fileKind === "svg") {
      return (
        <Suspense fallback={renderPreviewEmpty("Loading SVG preview...")}>
          <TerminalSvgPreview content={previewContent} />
        </Suspense>
      );
    }
    if (selection.viewMode === "preview" && fileKind === "html") {
      const version = side?.version;
      if (!version) return renderPreviewEmpty("HTML 版本不可用，请重新加载");
      return <TerminalHtmlPreview
        key={`${currentFileDiff.changeKind}:${currentFileDiff.baseOid ?? currentFileDiff.commitOid ?? ""}:${currentFileDiff.path}:${version}`}
        apiBase={apiBase} token={token} projectId={activeProject.projectId}
        path={currentFileDiff.path} content={previewContent} savedContent={previewContent}
        mtimeMs={0} refreshKey={0} editable={false}
        lineReferencePath={currentFileDiff.absolutePath}
        onContentChange={ignoreContentChange}
        change={{
          kind: currentFileDiff.changeKind,
          version,
          baseOid: currentFileDiff.baseOid,
          commitOid: currentFileDiff.commitOid,
        }}
        previewOnly
      />;
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
          initialRevealPosition={
            markdownReference.lineTarget?.path === currentFileDiff.path
              ? markdownReference.lineTarget
              : undefined
          }
        />
      </Suspense>
    );
  };

  let content: ReactNode;
  if (diff.error && !showDiffLoading) {
    content = <div className="p-6 text-sm text-rose-300">
      <p>{diff.error}</p>
      {selection.path && selection.kind && <button className="mt-3 underline"
        onClick={() => commands.reloadDiff(selection.path!, selection.kind!)}>重新加载</button>}
    </div>;
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
    if (
      selection.scope === "working" &&
      changes.data &&
      changes.data.staged.length === 0 &&
      changes.data.working.length === 0
    ) {
      content = renderPreviewEmpty(
        "当前工作区没有未提交改动。若 Agent 已提交修改，可切换到顶部「相对主分支」或「本分支提交」只读审阅本分支改动。",
      );
    } else if (
      selection.scope === "branch" &&
      branchChanges.data?.state === "unavailable"
    ) {
      content = renderPreviewEmpty("当前仓库状态不可对比主分支，请查看左侧原因说明");
    } else if (
      selection.scope === "commits" &&
      branchCommits.data?.state === "unavailable"
    ) {
      content = renderPreviewEmpty("当前仓库状态不可读取本分支提交，请查看左侧原因说明");
    } else {
      content = renderPreviewEmpty("Select a changed file");
    }
  } else {
    content = renderFileDiffContent(diff.data, diff.data.path);
  }

  if (
    selection.scope === "working" &&
    !changes.error &&
    changes.data?.repoRoot === null
  ) {
    return renderPreviewEmpty(
      "This project is not a Git repository. Use Explorer to browse files.",
    );
  }

  const workingCount = changes.data
    ? changes.data.staged.length + changes.data.working.length
    : undefined;
  const branchBaseLabel =
    branchChanges.data?.baseRef ??
    branchCommits.data?.baseRef ??
    (activeProject.mainBranch ? `origin/${activeProject.mainBranch}` : "主分支");
  const branchCount =
    branchChanges.data?.state === "ready"
      ? branchChanges.data.files.length
      : undefined;
  const commitsCount =
    branchCommits.data?.state === "ready"
      ? branchCommits.data.commits.length
      : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/80 px-2.5 py-1.5 text-xs">
        <div
          className="inline-flex rounded-md border border-slate-800 bg-slate-900/80 p-0.5"
          role="tablist"
          aria-label="Review changes scope"
        >
          <button
            type="button"
            role="tab"
            data-testid="changes-scope-working"
            aria-selected={selection.scope === "working"}
            onClick={() => commands.selectScope("working")}
            className={[
              "rounded px-2 py-0.5 text-xs transition-colors",
              selection.scope === "working"
                ? "bg-slate-700 font-medium text-white"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            未提交{workingCount !== undefined ? ` (${workingCount})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            data-testid="changes-scope-branch"
            aria-selected={selection.scope === "branch"}
            onClick={() => commands.selectScope("branch")}
            className={[
              "rounded px-2 py-0.5 text-xs transition-colors",
              selection.scope === "branch"
                ? "bg-slate-700 font-medium text-white"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            相对 {branchBaseLabel}
            {branchCount !== undefined ? ` (${branchCount})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            data-testid="changes-scope-commits"
            aria-selected={selection.scope === "commits"}
            onClick={() => commands.selectScope("commits")}
            className={[
              "rounded px-2 py-0.5 text-xs transition-colors",
              selection.scope === "commits"
                ? "bg-slate-700 font-medium text-white"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            本分支提交
            {commitsCount !== undefined
              ? ` (${commitsCount}${branchCommits.data?.truncated ? "+" : ""})`
              : ""}
          </button>
        </div>
        {selection.scope !== "working" ? (
          <span className="text-[11px] text-slate-500">只读审阅视图</span>
        ) : null}
      </div>
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}
      >
        <TerminalPreviewChangeTree
          scope={selection.scope}
          changes={changes.data}
          changesLoading={changes.loading}
          changesError={changes.error}
          branchChanges={branchChanges.data}
          branchChangesLoading={branchChanges.loading}
          branchChangesError={branchChanges.error}
          branchCommits={branchCommits.data}
          branchCommitsLoading={branchCommits.loading}
          branchCommitsError={branchCommits.error}
          selectedChangePath={selection.path}
          selectedChangeKind={selection.kind}
          onSelectScope={commands.selectScope}
          onSelectCommit={commands.selectCommit}
          onRequestRenameFile={commands.requestRename}
          onRequestDeleteFile={commands.requestDelete}
          onRequestResetChange={commands.requestReset}
          onSelectChange={commands.select}
          onReloadDiff={commands.reloadDiff}
          onOpenModeFile={commands.openFileMode}
        />
        <div className="min-h-0">{content}</div>
      </div>
    </div>
  );
}
