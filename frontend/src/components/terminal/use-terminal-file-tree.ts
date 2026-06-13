import { useCallback, useRef, useState } from "react";
import type {
  TerminalPreviewDirectoryResponse,
  TerminalPreviewTreeEntry,
} from "@runweave/shared";
import type { TreeItem, TreeItemIndex } from "react-complex-tree";
import { listTerminalProjectPreviewDirectory } from "../../services/terminal";

export interface FileTreeData {
  basename: string;
  relativePath: string;
  kind: "file" | "directory";
}

type FileTreeItems = Record<TreeItemIndex, TreeItem<FileTreeData>>;

interface UseTerminalFileTreeParams {
  apiBase: string;
  token: string;
  projectId: string | null;
  hasProjectPath: boolean;
  onOpenFilePath: (filePath: string) => void;
}

export interface UseTerminalFileTreeReturn {
  items: FileTreeItems;
  expandedItems: TreeItemIndex[];
  focusedItem: TreeItemIndex | undefined;
  selectedItems: TreeItemIndex[];
  loading: boolean;
  error: string | null;
  loadRootDirectory: () => void;
  handleExpandItem: (item: TreeItem<FileTreeData>) => void;
  handleCollapseItem: (item: TreeItem<FileTreeData>) => void;
  handleFocusItem: (item: TreeItem<FileTreeData>) => void;
  handleSelectItems: (items: TreeItemIndex[]) => void;
  handlePrimaryAction: (item: TreeItem<FileTreeData>) => void;
  handleMissingItems: (itemIds: TreeItemIndex[]) => void;
  revealFile: (relativePath: string) => Promise<void>;
  invalidateDirectory: (directoryPath: string) => void;
  resetTree: () => void;
}

function createRootItem(): TreeItem<FileTreeData> {
  return {
    index: "root",
    isFolder: true,
    children: [],
    data: { basename: "", relativePath: "", kind: "directory" },
  };
}

function normalizeDirectoryPath(directoryPath: string): string {
  const normalized = directoryPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized === "" || normalized === "." ? "." : normalized;
}

function entryToTreeItem(
  entry: TerminalPreviewTreeEntry,
): TreeItem<FileTreeData> {
  return {
    index: entry.path,
    isFolder: entry.kind === "directory",
    children: entry.kind === "directory" ? [] : undefined,
    data: {
      basename: entry.basename,
      relativePath: entry.path,
      kind: entry.kind,
    },
  };
}

function mergeDirectoryResponse(
  items: FileTreeItems,
  parentPath: string,
  response: TerminalPreviewDirectoryResponse,
): FileTreeItems {
  const next = { ...items };
  const childKeys: TreeItemIndex[] = [];

  for (const entry of response.entries) {
    next[entry.path] = entryToTreeItem(entry);
    childKeys.push(entry.path);
  }

  const parentKey =
    parentPath === "." || parentPath === "" ? "root" : parentPath;
  const parentItem = next[parentKey];
  if (parentItem) {
    next[parentKey] = { ...parentItem, children: childKeys };
  }

  return next;
}

export function useTerminalFileTree({
  apiBase,
  token,
  projectId,
  hasProjectPath,
  onOpenFilePath,
}: UseTerminalFileTreeParams): UseTerminalFileTreeReturn {
  const [items, setItems] = useState<FileTreeItems>({ root: createRootItem() });
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex | undefined>();
  const [selectedItems, setSelectedItems] = useState<TreeItemIndex[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadedDirsRef = useRef<Set<string>>(new Set());
  const inflightRef = useRef<
    Map<string, Promise<TerminalPreviewDirectoryResponse>>
  >(new Map());
  const directoryVersionsRef = useRef<Map<string, number>>(new Map());

  const loadDirectory = useCallback(
    async (
      relativePath: string,
    ): Promise<TerminalPreviewDirectoryResponse | null> => {
      if (!projectId || !hasProjectPath) return null;

      const normalizedPath = normalizeDirectoryPath(relativePath);
      const inflight = inflightRef.current.get(normalizedPath);
      if (inflight) return inflight;

      const requestVersion =
        directoryVersionsRef.current.get(normalizedPath) ?? 0;
      const promise = listTerminalProjectPreviewDirectory(
        apiBase,
        token,
        projectId,
        {
          path: normalizedPath === "." ? "" : normalizedPath,
        },
      );

      inflightRef.current.set(normalizedPath, promise);

      try {
        const response = await promise;
        if (
          (directoryVersionsRef.current.get(normalizedPath) ?? 0) !==
          requestVersion
        ) {
          return response;
        }
        loadedDirsRef.current.add(normalizedPath);
        setItems((prev) =>
          mergeDirectoryResponse(prev, normalizedPath, response),
        );
        setError(null);
        return response;
      } catch (err) {
        setError((err as Error).message || "Failed to load directory");
        return null;
      } finally {
        if (inflightRef.current.get(normalizedPath) === promise) {
          inflightRef.current.delete(normalizedPath);
        }
      }
    },
    [apiBase, token, projectId, hasProjectPath],
  );

  const loadRootDirectory = useCallback(() => {
    if (!projectId || !hasProjectPath) return;
    setLoading(true);
    loadDirectory(".").finally(() => setLoading(false));
  }, [projectId, hasProjectPath, loadDirectory]);

  const handleExpandItem = useCallback(
    (item: TreeItem<FileTreeData>) => {
      setExpandedItems((prev) =>
        prev.includes(item.index) ? prev : [...prev, item.index],
      );
      const path = item.data.relativePath || ".";
      if (!loadedDirsRef.current.has(path)) {
        loadDirectory(path);
      }
    },
    [loadDirectory],
  );

  const handleCollapseItem = useCallback((item: TreeItem<FileTreeData>) => {
    setExpandedItems((prev) => prev.filter((id) => id !== item.index));
  }, []);

  const handleFocusItem = useCallback((item: TreeItem<FileTreeData>) => {
    setFocusedItem(item.index);
  }, []);

  const handleSelectItems = useCallback((items: TreeItemIndex[]) => {
    setSelectedItems(items);
  }, []);

  const handlePrimaryAction = useCallback(
    (item: TreeItem<FileTreeData>) => {
      if (item.data.kind === "file") {
        onOpenFilePath(item.data.relativePath);
      } else {
        setExpandedItems((prev) =>
          prev.includes(item.index)
            ? prev.filter((id) => id !== item.index)
            : [...prev, item.index],
        );
        const path = item.data.relativePath || ".";
        if (!loadedDirsRef.current.has(path)) {
          loadDirectory(path);
        }
      }
    },
    [onOpenFilePath, loadDirectory],
  );

  const handleMissingItems = useCallback(
    (itemIds: TreeItemIndex[]) => {
      const dirs = new Set<string>();
      for (const id of itemIds) {
        const item = items[id];
        if (item?.isFolder) {
          dirs.add(item.data.relativePath || ".");
        }
      }
      for (const dir of dirs) {
        if (!loadedDirsRef.current.has(dir)) {
          loadDirectory(dir);
        }
      }
    },
    [items, loadDirectory],
  );

  const revealFile = useCallback(
    async (relativePath: string) => {
      if (!relativePath) return;

      if (!loadedDirsRef.current.has(".")) {
        await loadDirectory(".");
      }

      const segments = relativePath.split("/");
      const pathsToExpand: string[] = [];
      for (let i = 1; i < segments.length; i++) {
        pathsToExpand.push(segments.slice(0, i).join("/"));
      }

      for (const dirPath of pathsToExpand) {
        if (!loadedDirsRef.current.has(dirPath)) {
          await loadDirectory(dirPath);
        }
      }

      setExpandedItems((prev) => {
        const next = [...prev];
        for (const p of pathsToExpand) {
          if (!next.includes(p)) next.push(p);
        }
        return next;
      });

      setSelectedItems([relativePath]);
      setFocusedItem(relativePath);
    },
    [loadDirectory],
  );

  const invalidateDirectory = useCallback(
    (directoryPath: string) => {
      const normalized = normalizeDirectoryPath(directoryPath);
      const shouldReload =
        loadedDirsRef.current.has(normalized) ||
        inflightRef.current.has(normalized);
      loadedDirsRef.current.delete(normalized);
      inflightRef.current.delete(normalized);
      directoryVersionsRef.current.set(
        normalized,
        (directoryVersionsRef.current.get(normalized) ?? 0) + 1,
      );
      if (shouldReload) {
        void loadDirectory(normalized);
      }
    },
    [loadDirectory],
  );

  const resetTree = useCallback(() => {
    setItems({ root: createRootItem() });
    setExpandedItems([]);
    setFocusedItem(undefined);
    setSelectedItems([]);
    setError(null);
    loadedDirsRef.current.clear();
    inflightRef.current.clear();
    directoryVersionsRef.current.clear();
  }, []);

  return {
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
    invalidateDirectory,
    resetTree,
  };
}
