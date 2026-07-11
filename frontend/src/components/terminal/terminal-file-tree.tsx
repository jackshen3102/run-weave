import { useMemoizedFn } from "ahooks";
import { useMemo, useState } from "react";
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
  view: {
    expandedItems: Array<string | number>;
    focusedItem: string | number | undefined;
    selectedItems: Array<string | number>;
  };
  treeEvents: {
    onExpandItem: (item: TreeItem<FileTreeData>) => void;
    onCollapseItem: (item: TreeItem<FileTreeData>) => void;
    onFocusItem: (item: TreeItem<FileTreeData>) => void;
    onSelectItems: (items: Array<string | number>) => void;
    onPrimaryAction: (item: TreeItem<FileTreeData>) => void;
    onMissingItems: (itemIds: Array<string | number>) => void;
  };
  itemActions: {
    onFileClick: (relativePath: string) => void;
    onDirectoryClick: (item: TreeItem<FileTreeData>) => void;
    onRequestRenameFile: (relativePath: string) => void;
    onRequestDeleteFile: (relativePath: string) => void;
  };
}

export function TerminalFileTree({
  items,
  itemActions,
  treeEvents,
  view,
}: TerminalFileTreeProps) {
  const { expandedItems, focusedItem, selectedItems } = view;
  const {
    onCollapseItem,
    onExpandItem,
    onFocusItem,
    onMissingItems,
    onPrimaryAction,
    onSelectItems,
  } = treeEvents;
  const {
    onDirectoryClick,
    onFileClick,
    onRequestDeleteFile,
    onRequestRenameFile,
  } = itemActions;
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

  const renderItem = useMemoizedFn(
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
