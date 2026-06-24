import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewGitChangesResponse,
} from "@runweave/shared";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";

interface TerminalPreviewChangeTreeProps {
  changes: TerminalPreviewGitChangesResponse | null;
  changesLoading: boolean;
  changesError: string | null;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
  onRequestRenameFile: (filePath: string) => void;
  onRequestDeleteFile: (filePath: string) => void;
  onRequestResetChange: (
    filePath: string,
    kind: TerminalPreviewChangeKind,
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

function compactDirectory(
  node: ChangeTreeDirectoryNode,
): ChangeTreeDirectoryNode {
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

  return sortChangeTreeNodes(
    [...root.children.values()].map(convertChangeTreeNode),
  );
}

export function TerminalPreviewChangeTree({
  changes,
  changesLoading,
  changesError,
  selectedChangePath,
  selectedChangeKind,
  onRequestRenameFile,
  onRequestDeleteFile,
  onRequestResetChange,
  onSelectChange,
  onReloadDiff,
  onOpenModeFile,
}: TerminalPreviewChangeTreeProps) {
  const [collapsedChangeTree, setCollapsedChangeTree] = useState(false);
  const [collapsedChangeDirectories, setCollapsedChangeDirectories] = useState<
    Record<string, boolean>
  >({});
  const stagedChangeTree = useMemo(
    () => buildChangeTree(changes?.staged ?? []),
    [changes?.staged],
  );
  const workingChangeTree = useMemo(
    () => buildChangeTree(changes?.working ?? []),
    [changes?.working],
  );
  const noChanges =
    changes && changes.staged.length === 0 && changes.working.length === 0;

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
            {collapsed
              ? null
              : renderChangeTreeNodes(kind, node.children, depth + 1)}
          </div>
        );
      }

      const selected =
        selectedChangePath === node.file.path && selectedChangeKind === kind;
      const selectChangeFile = () => {
        if (selected) {
          onReloadDiff(node.file.path, kind);
          return;
        }
        onSelectChange(node.file.path, kind);
      };
      return (
        <ContextMenu key={`${kind}:file:${node.file.path}`}>
          <ContextMenuTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              className={[
                "flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-xs",
                selected
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-300 hover:bg-slate-900",
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
              <span className="w-3.5 shrink-0 text-center text-[9px] text-slate-500">
                {statusBadge(node.file.status)}
              </span>
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem
              onSelect={() => onRequestRenameFile(node.file.path)}
            >
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

  return (
    <aside
      className={[
        "group relative min-h-0 overflow-auto border-r border-slate-800",
        collapsedChangeTree ? "w-8" : "w-[220px]",
      ].join(" ")}
    >
      <button
        type="button"
        className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-slate-950/90 text-slate-500 opacity-0 transition-opacity hover:bg-slate-900 hover:text-slate-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
        aria-label={
          collapsedChangeTree ? "Show changes tree" : "Hide changes tree"
        }
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
        <div className="px-2 py-3 text-xs text-slate-400">
          Loading changes...
        </div>
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
            "Staged Changes",
            "staged",
            changes.staged,
            stagedChangeTree,
          )}
          {renderChangesTreeSection(
            "Working Changes",
            "working",
            changes.working,
            workingChangeTree,
          )}
        </div>
      ) : null}
    </aside>
  );
}
