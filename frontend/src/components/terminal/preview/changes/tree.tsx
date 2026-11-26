import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  GitCommit,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  TerminalPreviewBranchChangesResponse,
  TerminalPreviewBranchCommitsResponse,
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewChangeScope,
  TerminalPreviewComparisonUnavailableReason,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewWritableChangeKind,
} from "@runweave/shared/terminal/preview";
import { Button } from "../../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../../ui/context-menu";

interface TerminalPreviewChangeTreeProps {
  scope: TerminalPreviewChangeScope;
  changes: TerminalPreviewGitChangesResponse | null;
  changesLoading: boolean;
  changesError: string | null;
  branchChanges: TerminalPreviewBranchChangesResponse | null;
  branchChangesLoading: boolean;
  branchChangesError: string | null;
  branchCommits: TerminalPreviewBranchCommitsResponse | null;
  branchCommitsLoading: boolean;
  branchCommitsError: string | null;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
  onSelectScope: (scope: TerminalPreviewChangeScope) => void;
  onSelectCommit: (commitOid: string) => void;
  onRequestRenameFile: (filePath: string) => void;
  onRequestDeleteFile: (filePath: string) => void;
  onRequestResetChange: (
    filePath: string,
    kind: TerminalPreviewWritableChangeKind,
  ) => void;
  onSelectChange: (filePath: string, kind: TerminalPreviewChangeKind) => void;
  onReloadDiff: (filePath: string, kind: TerminalPreviewChangeKind) => void;
  onOpenModeFile: () => void;
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

function statusBadge(status: TerminalPreviewChangeFile["status"]): string {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "untracked": return "U";
    case "modified": return "M";
    default: return "?";
  }
}

function compactDirectory(node: ChangeTreeDirectoryNode): ChangeTreeDirectoryNode {
  let current = node;
  while (current.children.length === 1 && current.children[0]?.type === "directory") {
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
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function convertChangeTreeNode(node: MutableChangeTreeNode): ChangeTreeNode {
  if (node.type === "file") return node;
  const children = sortChangeTreeNodes([...node.children.values()].map(convertChangeTreeNode));
  return compactDirectory({ type: "directory", name: node.name, path: node.path, children });
}

function buildChangeTree(files: TerminalPreviewChangeFile[]): ChangeTreeNode[] {
  const root: MutableChangeTreeDirectory = { type: "directory", name: "", path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
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
    directory.children.set(name, { type: "file", name, path: file.path, file });
  }
  return sortChangeTreeNodes([...root.children.values()].map(convertChangeTreeNode));
}

function describeUnavailableReason(reason?: TerminalPreviewComparisonUnavailableReason): string {
  switch (reason) {
    case "not-repository":
      return "当前项目不是 Git 仓库";
    case "shallow-repository":
      return "浅克隆仓库（shallow repository）无法计算相对主分支的共同祖先";
    case "base-unavailable":
      return "无法解析远端主分支基准引用，请检查远端或项目主分支设置";
    case "no-merge-base":
      return "当前分支与主分支没有共同历史（no merge-base），无法对比";
    default:
      return "当前仓库状态暂不支持分支对比";
  }
}

export function TerminalPreviewChangeTree({
  scope,
  changes,
  changesLoading,
  changesError,
  branchChanges,
  branchChangesLoading,
  branchChangesError,
  branchCommits,
  branchCommitsLoading,
  branchCommitsError,
  selectedChangePath,
  selectedChangeKind,
  onSelectScope,
  onSelectCommit,
  onRequestRenameFile,
  onRequestDeleteFile,
  onRequestResetChange,
  onSelectChange,
  onReloadDiff,
  onOpenModeFile,
}: TerminalPreviewChangeTreeProps) {
  const [collapsedChangeTree, setCollapsedChangeTree] = useState(false);
  const [collapsedChangeDirectories, setCollapsedChangeDirectories] = useState<Record<string, boolean>>({});
  const stagedChangeTree = useMemo(() => buildChangeTree(changes?.staged ?? []), [changes?.staged]);
  const workingChangeTree = useMemo(() => buildChangeTree(changes?.working ?? []), [changes?.working]);
  const branchChangeTree = useMemo(() => buildChangeTree(branchChanges?.files ?? []), [branchChanges?.files]);
  const commitChangeTree = useMemo(() => buildChangeTree(branchCommits?.files ?? []), [branchCommits?.files]);
  const noWorkingChanges = changes && changes.staged.length === 0 && changes.working.length === 0;
  const branchFileCount = branchChanges?.state === "ready" ? branchChanges.files.length : undefined;

  const renderChangeTreeNodes = (kind: TerminalPreviewChangeKind, nodes: ChangeTreeNode[], depth = 0): ReactNode =>
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
              onClick={() => setCollapsedChangeDirectories((current) => ({ ...current, [collapseKey]: !collapsed }))}
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

      const selected = selectedChangePath === node.file.path && selectedChangeKind === kind;
      const selectChangeFile = () => {
        if (selected) onReloadDiff(node.file.path, kind);
        else onSelectChange(node.file.path, kind);
      };
      const fileItem = (
        <div
          role="button"
          tabIndex={0}
          className={[
            "flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-xs",
            selected ? "bg-slate-800 text-slate-100" : "text-slate-300 hover:bg-slate-900",
          ].join(" ")}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={node.file.path}
          onClick={selectChangeFile}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              selectChangeFile();
            }
          }}
        >
          <span className="w-3.5 shrink-0 text-center text-[9px] text-slate-500">{statusBadge(node.file.status)}</span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </div>
      );

      if (scope !== "working" || (kind !== "staged" && kind !== "working")) {
        return <div key={`${kind}:file:${node.file.path}`}>{fileItem}</div>;
      }

      return (
        <ContextMenu key={`${kind}:file:${node.file.path}`}>
          <ContextMenuTrigger asChild>{fileItem}</ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem onSelect={() => onRequestRenameFile(node.file.path)}>
              <Pencil className="h-4 w-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onRequestResetChange(node.file.path, kind)}
              className="text-amber-300 focus:text-amber-300"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onRequestDeleteFile(node.file.path)}
              className="text-rose-400 focus:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      );
    });

  const renderChangesTreeSection = (
    title: string,
    kind: TerminalPreviewChangeKind,
    files: TerminalPreviewChangeFile[],
    nodes: ChangeTreeNode[],
  ): ReactNode => {
    if (files.length === 0) return null;
    return (
      <div className="flex flex-col">
        <div className="flex h-7 items-center justify-between px-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
          <span className="truncate">{title}</span>
          <span className="tracking-normal">{files.length}</span>
        </div>
        {renderChangeTreeNodes(kind, nodes)}
      </div>
    );
  };

  let body: ReactNode = null;
  if (scope === "working") {
    if (changesLoading && !changes) {
      body = <div className="px-2 py-3 text-xs text-slate-400">Loading changes...</div>;
    } else if (changesError) {
      body = <div className="px-2 py-3 text-xs text-rose-300">{changesError}</div>;
    } else if (noWorkingChanges) {
      body = (
        <div className="flex flex-col gap-2 px-2 py-3 text-xs text-slate-400">
          <span>当前工作区没有未提交改动</span>
          <p className="text-[11px] leading-relaxed text-slate-500">
            若 Agent 已将修改提交至本分支，可切到「相对主分支」或「本分支提交」审阅已提交改动。
          </p>
          {branchFileCount && branchFileCount > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 justify-start rounded-md px-2 text-xs text-sky-300"
              onClick={() => onSelectScope("branch")}
            >
              查看相对 {branchChanges?.baseRef ?? "主分支"} ({branchFileCount})
            </Button>
          ) : null}
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
      );
    } else if (changes) {
      body = (
        <div className="flex flex-col gap-1 p-1.5">
          {renderChangesTreeSection("Staged Changes", "staged", changes.staged, stagedChangeTree)}
          {renderChangesTreeSection("Working Changes", "working", changes.working, workingChangeTree)}
        </div>
      );
    }
  } else if (scope === "branch") {
    if (branchChangesLoading && !branchChanges) {
      body = <div className="px-2 py-3 text-xs text-slate-400">正在对比主分支改动...</div>;
    } else if (branchChangesError) {
      body = <div className="px-2 py-3 text-xs text-rose-300">{branchChangesError}</div>;
    } else if (branchChanges?.state === "unavailable") {
      body = (
        <div
          role="status"
          data-testid="branch-changes-unavailable"
          className="flex flex-col gap-1.5 px-2.5 py-3 text-xs text-amber-300"
        >
          <span className="font-medium">无法对比主分支</span>
          <span className="text-[11px] leading-relaxed text-slate-400">
            {describeUnavailableReason(branchChanges.reason)}
          </span>
        </div>
      );
    } else if (branchChanges && branchChanges.files.length === 0) {
      body = (
        <div className="flex flex-col gap-1.5 px-2.5 py-3 text-xs text-slate-400">
          <span>相对 {branchChanges.baseRef ?? "主分支"} 暂无变更</span>
          {branchChanges.mergeBaseOid ? (
            <span className="font-mono text-[10px] text-slate-500">
              merge-base {branchChanges.mergeBaseOid.slice(0, 7)}
            </span>
          ) : null}
        </div>
      );
    } else if (branchChanges) {
      body = (
        <div className="flex flex-col gap-1 p-1.5">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-slate-400">
            <GitBranch className="h-3 w-3 shrink-0 text-sky-400" />
            <span className="truncate" title={branchChanges.baseRef}>
              基准：{branchChanges.baseRef ?? "主分支"}
              {branchChanges.mergeBaseOid ? ` @ ${branchChanges.mergeBaseOid.slice(0, 7)}` : ""}
            </span>
          </div>
          {renderChangesTreeSection("Branch Net Changes", "branch", branchChanges.files, branchChangeTree)}
        </div>
      );
    }
  } else if (scope === "commits") {
    if (branchCommitsLoading && !branchCommits) {
      body = <div className="px-2 py-3 text-xs text-slate-400">正在读取本分支提交...</div>;
    } else if (branchCommitsError) {
      body = <div className="px-2 py-3 text-xs text-rose-300">{branchCommitsError}</div>;
    } else if (branchCommits?.state === "unavailable") {
      body = (
        <div
          role="status"
          data-testid="branch-commits-unavailable"
          className="flex flex-col gap-1.5 px-2.5 py-3 text-xs text-amber-300"
        >
          <span className="font-medium">无法读取本分支提交</span>
          <span className="text-[11px] leading-relaxed text-slate-400">
            {describeUnavailableReason(branchCommits.reason)}
          </span>
        </div>
      );
    } else if (branchCommits && branchCommits.commits.length === 0) {
      body = (
        <div className="flex flex-col gap-1.5 px-2.5 py-3 text-xs text-slate-400">
          <span>相对 {branchCommits.baseRef ?? "主分支"} 暂无本分支独占提交</span>
        </div>
      );
    } else if (branchCommits) {
      body = (
        <div className="flex flex-col gap-1.5 p-1.5">
          <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-slate-500">
            <span>
              本分支提交 ({branchCommits.commits.length}
              {branchCommits.truncated ? "+" : ""})
            </span>
            {branchCommits.truncated ? (
              <span className="tracking-normal text-amber-400">仅展示最近 50 个提交</span>
            ) : null}
          </div>
          <div className="max-h-48 overflow-y-auto rounded-md border border-slate-800/80 bg-slate-950/60 p-1">
            {branchCommits.commits.map((commit) => {
              const isSelected = commit.oid === branchCommits.selectedCommitOid;
              return (
                <button
                  key={commit.oid}
                  type="button"
                  data-testid={`branch-commit-${commit.shortOid}`}
                  onClick={() => onSelectCommit(commit.oid)}
                  className={[
                    "flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left text-xs transition-colors",
                    isSelected
                      ? "bg-sky-950/70 text-slate-100 ring-1 ring-sky-500/40"
                      : "text-slate-300 hover:bg-slate-900",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-1.5">
                    <GitCommit className="h-3 w-3 shrink-0 text-sky-400" />
                    <span className="font-mono text-[11px] text-sky-300">{commit.shortOid}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{commit.subject}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 pl-4 text-[10px] text-slate-500">
                    <span className="truncate">{commit.authorName}</span>
                    <time className="shrink-0">{new Date(commit.committedAt).toLocaleDateString()}</time>
                  </div>
                </button>
              );
            })}
          </div>
          {branchCommits.files.length === 0 ? (
            <div className="px-2 py-2 text-xs text-slate-500">此提交在当前项目目录下无文件变更</div>
          ) : (
            renderChangesTreeSection(
              `Commit ${branchCommits.selectedCommitOid?.slice(0, 7) ?? ""}`,
              "commit",
              branchCommits.files,
              commitChangeTree,
            )
          )}
        </div>
      );
    }
  }

  return (
    <aside
      className={[
        "group relative min-h-0 overflow-auto border-r border-slate-800",
        collapsedChangeTree ? "w-8" : "w-[240px]",
      ].join(" ")}
    >
      <button
        type="button"
        className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-slate-950/90 text-slate-500 opacity-0 transition-opacity hover:bg-slate-900 hover:text-slate-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
        aria-label={collapsedChangeTree ? "Show changes tree" : "Hide changes tree"}
        onClick={() => setCollapsedChangeTree((current) => !current)}
      >
        {collapsedChangeTree ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
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
      ) : (
        <div className="pt-6">{body}</div>
      )}
    </aside>
  );
}
