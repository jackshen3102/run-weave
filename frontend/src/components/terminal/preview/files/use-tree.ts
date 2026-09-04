import { useMemoizedFn } from "ahooks";
import { useRef, useState } from "react";
import type { TerminalPreviewDirectoryResponse, TerminalPreviewTreeEntry } from "@runweave/shared/terminal/preview";
import type { TreeItem, TreeItemIndex } from "react-complex-tree";
import { listTerminalProjectPreviewDirectory } from "../../../../services/terminal/index";

export interface FileTreeData {
  basename: string;
  relativePath: string;
  kind: "file" | "directory";
}

type FileTreeItems = Record<TreeItemIndex, TreeItem<FileTreeData>>;
type DirectoryErrors = Record<string, string>;
type TruncatedDirectories = Record<string, number>;

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
  loadingDirectories: ReadonlySet<string>;
  directoryErrors: DirectoryErrors;
  truncatedDirectories: TruncatedDirectories;
  loadRootDirectory: () => Promise<void>;
  refreshTree: () => Promise<void>;
  reloadDirectory: (directoryPath: string) => Promise<void>;
  handleExpandItem: (item: TreeItem<FileTreeData>) => void;
  handleCollapseItem: (item: TreeItem<FileTreeData>) => void;
  handleFocusItem: (item: TreeItem<FileTreeData>) => void;
  handleSelectItems: (items: TreeItemIndex[]) => void;
  handlePrimaryAction: (item: TreeItem<FileTreeData>) => void;
  handleMissingItems: (itemIds: TreeItemIndex[]) => void;
  revealFile: (relativePath: string) => Promise<void>;
  revealDirectory: (relativePath: string) => Promise<void>;
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
  existingItem?: TreeItem<FileTreeData>,
): TreeItem<FileTreeData> {
  const children =
    entry.kind === "directory"
      ? existingItem?.isFolder
        ? existingItem.children
        : []
      : undefined;

  return {
    index: entry.path,
    isFolder: entry.kind === "directory",
    children,
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
    next[entry.path] = entryToTreeItem(entry, next[entry.path]);
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
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
    () => new Set(),
  );
  const [directoryErrors, setDirectoryErrors] = useState<DirectoryErrors>({});
  const [truncatedDirectories, setTruncatedDirectories] =
    useState<TruncatedDirectories>({});

  const loadedDirsRef = useRef<Set<string>>(new Set());
  const inflightRef = useRef<
    Map<string, Promise<TerminalPreviewDirectoryResponse | null>>
  >(new Map());
  const directoryVersionsRef = useRef<Map<string, number>>(new Map());
  const treeGenerationRef = useRef(0);

  const loadDirectory = useMemoizedFn(
    (
      relativePath: string,
    ): Promise<TerminalPreviewDirectoryResponse | null> => {
      if (!projectId || !hasProjectPath) return Promise.resolve(null);

      const normalizedPath = normalizeDirectoryPath(relativePath);
      const inflight = inflightRef.current.get(normalizedPath);
      if (inflight) return inflight;

      const requestProjectId = projectId;
      const requestGeneration = treeGenerationRef.current;
      const requestVersion =
        directoryVersionsRef.current.get(normalizedPath) ?? 0;
      setLoadingDirectories((prev) => {
        if (prev.has(normalizedPath)) return prev;
        const next = new Set(prev);
        next.add(normalizedPath);
        return next;
      });
      setDirectoryErrors((prev) => {
        if (!(normalizedPath in prev)) return prev;
        const next = { ...prev };
        delete next[normalizedPath];
        return next;
      });

      const request = listTerminalProjectPreviewDirectory(
        apiBase,
        token,
        requestProjectId,
        {
          path: normalizedPath === "." ? "" : normalizedPath,
        },
      );

      const promise: Promise<TerminalPreviewDirectoryResponse | null> = request
        .then((response) => {
          if (
            treeGenerationRef.current !== requestGeneration ||
            response.projectId !== requestProjectId ||
            (directoryVersionsRef.current.get(normalizedPath) ?? 0) !==
              requestVersion
          ) {
            return response;
          }
          loadedDirsRef.current.add(normalizedPath);
          setItems((prev) =>
            mergeDirectoryResponse(prev, normalizedPath, response),
          );
          setDirectoryErrors((prev) => {
            if (!(normalizedPath in prev)) return prev;
            const next = { ...prev };
            delete next[normalizedPath];
            return next;
          });
          setTruncatedDirectories((prev) => {
            if (response.truncated) {
              if (prev[normalizedPath] === response.limit) return prev;
              return { ...prev, [normalizedPath]: response.limit };
            }
            if (!(normalizedPath in prev)) return prev;
            const next = { ...prev };
            delete next[normalizedPath];
            return next;
          });
          return response;
        })
        .catch((err: unknown) => {
          if (
            treeGenerationRef.current === requestGeneration &&
            (directoryVersionsRef.current.get(normalizedPath) ?? 0) ===
              requestVersion
          ) {
            setDirectoryErrors((prev) => ({
              ...prev,
              [normalizedPath]:
                (err as Error).message || "Failed to load directory",
            }));
          }
          return null;
        })
        .finally(() => {
          if (
            treeGenerationRef.current === requestGeneration &&
            inflightRef.current.get(normalizedPath) === promise
          ) {
            inflightRef.current.delete(normalizedPath);
            setLoadingDirectories((prev) => {
              if (!prev.has(normalizedPath)) return prev;
              const next = new Set(prev);
              next.delete(normalizedPath);
              return next;
            });
          }
        });

      inflightRef.current.set(normalizedPath, promise);
      return promise;
    },
  );

  const loadRootDirectory = useMemoizedFn(async (): Promise<void> => {
    await loadDirectory(".");
  });

  const handleExpandItem = useMemoizedFn((item: TreeItem<FileTreeData>) => {
    setExpandedItems((prev) =>
      prev.includes(item.index) ? prev : [...prev, item.index],
    );
    const path = item.data.relativePath || ".";
    if (!loadedDirsRef.current.has(path)) {
      loadDirectory(path);
    }
  });

  const handleCollapseItem = useMemoizedFn((item: TreeItem<FileTreeData>) => {
    setExpandedItems((prev) => prev.filter((id) => id !== item.index));
  });

  const handleFocusItem = useMemoizedFn((item: TreeItem<FileTreeData>) => {
    setFocusedItem(item.index);
  });

  const handleSelectItems = useMemoizedFn((items: TreeItemIndex[]) => {
    setSelectedItems(items);
  });

  const handlePrimaryAction = useMemoizedFn((item: TreeItem<FileTreeData>) => {
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
  });

  const handleMissingItems = useMemoizedFn((itemIds: TreeItemIndex[]) => {
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
  });

  const revealFile = useMemoizedFn(async (relativePath: string) => {
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
  });

  const revealDirectory = useMemoizedFn(async (relativePath: string) => {
    if (!relativePath) return;

    if (!loadedDirsRef.current.has(".")) {
      await loadDirectory(".");
    }

    const segments = relativePath.split("/").filter(Boolean);
    const pathsToExpand: string[] = [];
    for (let i = 1; i <= segments.length; i++) {
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
  });

  const invalidateDirectory = useMemoizedFn((directoryPath: string) => {
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
  });

  const reloadDirectory = useMemoizedFn(
    async (directoryPath: string): Promise<void> => {
      const normalized = normalizeDirectoryPath(directoryPath);
      loadedDirsRef.current.delete(normalized);
      inflightRef.current.delete(normalized);
      directoryVersionsRef.current.set(
        normalized,
        (directoryVersionsRef.current.get(normalized) ?? 0) + 1,
      );
      await loadDirectory(normalized);
    },
  );

  const refreshTree = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !hasProjectPath) return;

    const directoryPaths = new Set<string>(["."]);
    for (const itemId of expandedItems) {
      const item = items[itemId];
      if (item?.isFolder) {
        directoryPaths.add(item.data.relativePath || ".");
      }
    }

    await Promise.all(
      Array.from(directoryPaths, (directoryPath) =>
        reloadDirectory(directoryPath),
      ),
    );
  });

  const resetTree = useMemoizedFn(() => {
    treeGenerationRef.current += 1;
    setItems({ root: createRootItem() });
    setExpandedItems([]);
    setFocusedItem(undefined);
    setSelectedItems([]);
    setLoadingDirectories(new Set());
    setDirectoryErrors({});
    setTruncatedDirectories({});
    loadedDirsRef.current.clear();
    inflightRef.current.clear();
    directoryVersionsRef.current.clear();
  });

  return {
    items,
    expandedItems,
    focusedItem,
    selectedItems,
    loading: loadingDirectories.has("."),
    error: directoryErrors["."] ?? null,
    loadingDirectories,
    directoryErrors,
    truncatedDirectories,
    loadRootDirectory,
    refreshTree,
    reloadDirectory,
    handleExpandItem,
    handleCollapseItem,
    handleFocusItem,
    handleSelectItems,
    handlePrimaryAction,
    handleMissingItems,
    revealFile,
    revealDirectory,
    invalidateDirectory,
    resetTree,
  };
}
