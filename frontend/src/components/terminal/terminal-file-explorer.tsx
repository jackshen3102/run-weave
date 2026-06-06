import { useCallback, useEffect } from "react";
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
    loadRootDirectory,
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

  const handleFileClick = useCallback(
    (relativePath: string) => {
      onOpenFilePath(relativePath);
    },
    [onOpenFilePath],
  );

  const handleDirectoryClick = useCallback(
    (item: TreeItem<FileTreeData>) => {
      if (expandedItems.includes(item.index)) {
        handleCollapseItem(item);
      } else {
        handleExpandItem(item);
      }
    },
    [expandedItems, handleCollapseItem, handleExpandItem],
  );

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
          onClick={loadRootDirectory}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TerminalFileTree
        items={items}
        expandedItems={expandedItems}
        focusedItem={focusedItem}
        selectedItems={selectedItems}
        onExpandItem={handleExpandItem}
        onCollapseItem={handleCollapseItem}
        onFocusItem={handleFocusItem}
        onSelectItems={handleSelectItems}
        onPrimaryAction={handlePrimaryAction}
        onMissingItems={handleMissingItems}
        onFileClick={handleFileClick}
        onDirectoryClick={handleDirectoryClick}
        onRequestRenameFile={onRequestRenameFile}
        onRequestDeleteFile={onRequestDeleteFile}
      />
    </div>
  );
}
