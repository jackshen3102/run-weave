import { useMemoizedFn } from "ahooks";
import { useEffect } from "react";
import type { TreeItem } from "react-complex-tree";
import { Loader2 } from "lucide-react";
import type {
  FileTreeData,
  UseTerminalFileTreeReturn,
} from "./use-terminal-file-tree";
import { TerminalFileTree } from "./terminal-file-tree";

interface TerminalFileExplorerProps {
  tree: UseTerminalFileTreeReturn;
  selectedFilePath?: string;
  onOpenFilePath: (filePath: string) => void;
  onRequestRenameFile: (filePath: string) => void;
  onRequestDeleteFile: (filePath: string) => void;
}

export function TerminalFileExplorer({
  tree,
  selectedFilePath,
  onOpenFilePath,
  onRequestRenameFile,
  onRequestDeleteFile,
}: TerminalFileExplorerProps) {
  const {
    items,
    expandedItems,
    focusedItem,
    selectedItems,
    loading,
    error,
    loadingDirectories,
    directoryErrors,
    truncatedDirectories,
    loadRootDirectory,
    reloadDirectory,
    handleExpandItem,
    handleCollapseItem,
    handleFocusItem,
    handleSelectItems,
    handlePrimaryAction,
    handleMissingItems,
    revealFile,
  } = tree;

  useEffect(() => {
    if (selectedFilePath) {
      void revealFile(selectedFilePath);
    }
  }, [selectedFilePath, revealFile]);

  const handleFileClick = useMemoizedFn((relativePath: string) => {
    onOpenFilePath(relativePath);
  });

  const handleDirectoryClick = useMemoizedFn((item: TreeItem<FileTreeData>) => {
    if (expandedItems.includes(item.index)) {
      handleCollapseItem(item);
    } else {
      handleExpandItem(item);
    }
  });

  if (loading && Object.keys(items).length <= 1) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
      </div>
    );
  }

  if (error && Object.keys(items).length <= 1) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-slate-400">
        <p>{error}</p>
        <button
          type="button"
          className="text-slate-300 underline hover:text-white"
          onClick={() => void loadRootDirectory()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {error ? (
        <div className="flex items-start justify-between gap-2 border-b border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
          <span>{error}</span>
          <button
            type="button"
            className="shrink-0 underline hover:text-rose-100"
            onClick={() => void loadRootDirectory()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {truncatedDirectories["."] ? (
        <div className="border-b border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          Showing the first {truncatedDirectories["."]} project entries.
        </div>
      ) : null}
      <TerminalFileTree
        items={items}
        view={{ expandedItems, focusedItem, selectedItems }}
        directoryState={{
          errors: directoryErrors,
          loading: loadingDirectories,
          truncated: truncatedDirectories,
        }}
        treeEvents={{
          onCollapseItem: handleCollapseItem,
          onExpandItem: handleExpandItem,
          onFocusItem: handleFocusItem,
          onMissingItems: handleMissingItems,
          onPrimaryAction: handlePrimaryAction,
          onSelectItems: handleSelectItems,
        }}
        itemActions={{
          onDirectoryClick: handleDirectoryClick,
          onFileClick: handleFileClick,
          onRequestDeleteFile,
          onRequestRenameFile,
          onRetryDirectory: (directoryPath) =>
            void reloadDirectory(directoryPath),
        }}
      />
    </div>
  );
}
