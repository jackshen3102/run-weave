import type { ReactElement } from "react";
import type {
  TreeItem,
  TreeItemRenderContext,
  TreeInformation,
} from "react-complex-tree";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import type { FileTreeData } from "./use-file-tree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";

interface TerminalFileTreeItemProps {
  item: TreeItem<FileTreeData>;
  depth: number;
  children: React.ReactNode | null;
  context: TreeItemRenderContext;
  info: TreeInformation;
  onFileClick: (relativePath: string) => void;
  onDirectoryClick: (item: TreeItem<FileTreeData>) => void;
  onRequestRenameFile: (relativePath: string) => void;
  onRequestDeleteFile: (relativePath: string) => void;
  onRetryDirectory: (relativePath: string) => void;
  loadingDirs: ReadonlySet<string>;
  directoryError?: string;
  truncatedLimit?: number;
}

export function TerminalFileTreeItem({
  item,
  depth,
  children,
  context,
  loadingDirs,
  directoryError,
  truncatedLimit,
  onFileClick,
  onDirectoryClick,
  onRequestRenameFile,
  onRequestDeleteFile,
  onRetryDirectory,
}: TerminalFileTreeItemProps): ReactElement {
  const isExpanded = context.isExpanded;
  const isSelected = context.isSelected;
  const isFocused = context.isFocused;
  const isLoading =
    item.isFolder && loadingDirs.has(item.data.relativePath || ".");

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.data.kind === "file") {
      onFileClick(item.data.relativePath);
    } else {
      onDirectoryClick(item);
    }
  };

  const row = (
    <div
      {...context.interactiveElementProps}
      onClick={handleClick}
      className={`flex cursor-pointer items-center gap-1 rounded-sm px-1 text-xs leading-7 select-none ${
        isSelected
          ? "bg-slate-700/60 text-slate-100"
          : isFocused
            ? "bg-slate-800/60 text-slate-200"
            : "text-slate-300 hover:bg-slate-800/40"
      }`}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
      title={item.data.relativePath}
    >
      {item.isFolder ? (
        isLoading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />
        ) : isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        )
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" />
      )}

      {item.isFolder ? (
        isExpanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
        )
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      )}

      <span className="truncate">{item.data.basename}</span>
    </div>
  );

  return (
    <li {...context.itemContainerWithChildrenProps} className="list-none">
      {item.data.kind === "file" ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem
              onSelect={() => onRequestRenameFile(item.data.relativePath)}
            >
              <Pencil className="h-4 w-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onRequestDeleteFile(item.data.relativePath)}
              className="text-rose-400 focus:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {children}
      {item.isFolder && isExpanded && directoryError ? (
        <div
          className="flex items-start justify-between gap-2 py-1 pr-2 text-xs text-rose-300"
          style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
        >
          <span className="min-w-0 truncate" title={directoryError}>
            {directoryError}
          </span>
          <button
            type="button"
            className="shrink-0 underline hover:text-rose-100"
            onClick={(event) => {
              event.stopPropagation();
              onRetryDirectory(item.data.relativePath);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {item.isFolder && isExpanded && truncatedLimit ? (
        <div
          className="py-1 pr-2 text-xs text-amber-300"
          style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
        >
          Showing the first {truncatedLimit} entries.
        </div>
      ) : null}
    </li>
  );
}
