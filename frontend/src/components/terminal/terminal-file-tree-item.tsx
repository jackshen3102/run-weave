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
import type { FileTreeData } from "./use-terminal-file-tree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";

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
  loadingDirs: Set<string>;
}

export function TerminalFileTreeItem({
  item,
  depth,
  children,
  context,
  loadingDirs,
  onFileClick,
  onDirectoryClick,
  onRequestRenameFile,
  onRequestDeleteFile,
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
    </li>
  );
}
