import { useCallback, useMemo, useState } from "react";
import { ControlledTreeEnvironment, Tree } from "react-complex-tree";
import type {
  TreeItem,
  TreeItemRenderContext,
  TreeInformation,
} from "react-complex-tree";
import type { FileTreeData } from "./use-terminal-file-tree";
import { TerminalFileTreeItem } from "./terminal-file-tree-item";

interface TerminalFileTreeProps {
  items: Record<string, TreeItem<FileTreeData>>;
  expandedItems: Array<string | number>;
  focusedItem: string | number | undefined;
  selectedItems: Array<string | number>;
  onExpandItem: (item: TreeItem<FileTreeData>) => void;
  onCollapseItem: (item: TreeItem<FileTreeData>) => void;
  onFocusItem: (item: TreeItem<FileTreeData>) => void;
  onSelectItems: (items: Array<string | number>) => void;
  onPrimaryAction: (item: TreeItem<FileTreeData>) => void;
  onMissingItems: (itemIds: Array<string | number>) => void;
  onFileClick: (relativePath: string) => void;
  onDirectoryClick: (item: TreeItem<FileTreeData>) => void;
  onRequestRenameFile: (relativePath: string) => void;
  onRequestDeleteFile: (relativePath: string) => void;
}

export function TerminalFileTree({
  items,
  expandedItems,
  focusedItem,
  selectedItems,
  onExpandItem,
  onCollapseItem,
  onFocusItem,
  onSelectItems,
  onPrimaryAction,
  onMissingItems,
  onFileClick,
  onDirectoryClick,
  onRequestRenameFile,
  onRequestDeleteFile,
}: TerminalFileTreeProps) {
  const [loadingDirs] = useState<Set<string>>(() => new Set());

  const viewState = useMemo(
    () => ({
      "file-tree": {
        expandedItems,
        focusedItem,
        selectedItems,
      },
    }),
    [expandedItems, focusedItem, selectedItems],
  );

  const renderItem = useCallback(
    (props: {
      item: TreeItem<FileTreeData>;
      depth: number;
      children: React.ReactNode | null;
      context: TreeItemRenderContext;
      info: TreeInformation;
    }) => (
      <TerminalFileTreeItem
        item={props.item}
        depth={props.depth}
        children={props.children}
        context={props.context}
        info={props.info}
        loadingDirs={loadingDirs}
        onFileClick={onFileClick}
        onDirectoryClick={onDirectoryClick}
        onRequestRenameFile={onRequestRenameFile}
        onRequestDeleteFile={onRequestDeleteFile}
      />
    ),
    [
      loadingDirs,
      onFileClick,
      onDirectoryClick,
      onRequestRenameFile,
      onRequestDeleteFile,
    ],
  );

  return (
    <ControlledTreeEnvironment
      items={items}
      getItemTitle={(item) => item.data.basename}
      viewState={viewState}
      onExpandItem={onExpandItem}
      onCollapseItem={onCollapseItem}
      onFocusItem={onFocusItem}
      onSelectItems={onSelectItems}
      onPrimaryAction={onPrimaryAction}
      onMissingItems={onMissingItems}
      canDragAndDrop={false}
      canReorderItems={false}
      canRename={false}
      canSearch={false}
      renderItem={renderItem}
    >
      <Tree treeId="file-tree" rootItem="root" treeLabel="Project Files" />
    </ControlledTreeEnvironment>
  );
}
