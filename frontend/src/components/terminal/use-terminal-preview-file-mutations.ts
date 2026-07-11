import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileResponse,
} from "@runweave/shared/terminal/preview";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import {
  deleteTerminalProjectPreviewFile,
  renameTerminalProjectPreviewFile,
  resetTerminalProjectPreviewChange,
} from "../../services/terminal";

export interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

export interface PreviewChangeResetTarget {
  path: string;
  kind: TerminalPreviewChangeKind;
}

interface PreviewMutationEditorPort {
  clear: () => void;
  confirmDiscard: () => boolean;
  loadedMtimeMs?: number;
  replaceFile: (file: TerminalPreviewFileResponse) => void;
}

interface PreviewMutationCachePort {
  clearDiff: (path?: string, kind?: TerminalPreviewChangeKind) => void;
  clearFile: (path?: string) => void;
  setFile: (file: TerminalPreviewFileResponse | null) => void;
}

interface PreviewMutationRefreshPort {
  changes: (options?: { preserveMode?: boolean }) => Promise<void>;
  fileSearch: () => Promise<void>;
  treeParents: (paths: string[]) => void;
}

interface UseTerminalPreviewFileMutationsOptions {
  cache: PreviewMutationCachePort;
  editor: PreviewMutationEditorPort;
  filePreview: TerminalPreviewFileResponse | null;
  handleRequestError: (error: unknown) => string;
  projectId: string | null;
  refresh: PreviewMutationRefreshPort;
}

export function useTerminalPreviewFileMutations({
  cache,
  editor,
  filePreview,
  handleRequestError,
  projectId,
  refresh,
}: UseTerminalPreviewFileMutationsOptions) {
  const { apiBase, token } = useTerminalRuntime();
  const projectState = useTerminalPreviewStore((state) =>
    projectId ? state.projects[projectId] : undefined,
  );
  const updateProjectPreview = useTerminalPreviewStore(
    (state) => state.updateProjectPreview,
  );
  const [deleteTarget, setDeleteTarget] =
    useState<PreviewFileMutationTarget | null>(null);
  const [renameTarget, setRenameTarget] =
    useState<PreviewFileMutationTarget | null>(null);
  const [resetTarget, setResetTarget] =
    useState<PreviewChangeResetTarget | null>(null);
  const [renamePath, setRenamePath] = useState("");
  const [pending, setPending] = useState<"delete" | "rename" | "reset" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const getTarget = useMemoizedFn(
    (path: string): PreviewFileMutationTarget => ({
      path,
      expectedMtimeMs:
        filePreview?.base === "project" &&
        filePreview.path === path &&
        editor.loadedMtimeMs !== undefined
          ? editor.loadedMtimeMs
          : undefined,
    }),
  );

  const requestRename = useMemoizedFn((path: string): void => {
    if (!projectId || !editor.confirmDiscard()) {
      return;
    }
    const target = getTarget(path);
    setError(null);
    setRenameTarget(target);
    setRenamePath(target.path);
  });

  const requestDelete = useMemoizedFn((path: string): void => {
    if (!projectId || !editor.confirmDiscard()) {
      return;
    }
    setError(null);
    setDeleteTarget(getTarget(path));
  });

  const requestReset = useMemoizedFn(
    (path: string, kind: TerminalPreviewChangeKind): void => {
      if (!projectId || !editor.confirmDiscard()) {
        return;
      }
      setError(null);
      setResetTarget({ path, kind });
    },
  );

  const submitRename = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !renameTarget || pending) {
      return;
    }
    const nextPath = renamePath.trim();
    if (!nextPath) {
      setError("New file path is required.");
      return;
    }
    setPending("rename");
    setError(null);
    try {
      const payload = await renameTerminalProjectPreviewFile(
        apiBase,
        token,
        projectId,
        {
          path: renameTarget.path,
          nextPath,
          expectedMtimeMs: renameTarget.expectedMtimeMs,
        },
      );
      cache.clearFile(renameTarget.path);
      cache.clearDiff();
      cache.setFile(payload);
      editor.replaceFile(payload);
      refresh.treeParents([renameTarget.path, payload.path]);
      updateProjectPreview(projectId, {
        mode: "file",
        selectedFilePath: payload.path,
        openFileQuery: payload.path,
        selectedChangePath: undefined,
        selectedChangeKind: undefined,
      });
      setRenameTarget(null);
      setRenamePath("");
      await refresh.fileSearch();
      void refresh.changes({ preserveMode: true });
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setPending(null);
    }
  });

  const submitDelete = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !deleteTarget || pending) {
      return;
    }
    setPending("delete");
    setError(null);
    try {
      await deleteTerminalProjectPreviewFile(apiBase, token, projectId, {
        path: deleteTarget.path,
        expectedMtimeMs: deleteTarget.expectedMtimeMs,
      });
      const deletedSelectedFile =
        projectState?.selectedFilePath === deleteTarget.path ||
        filePreview?.path === deleteTarget.path;
      const deletedSelectedChange =
        projectState?.selectedChangePath === deleteTarget.path;
      if (deletedSelectedFile) {
        cache.clearFile(deleteTarget.path);
        editor.clear();
      }
      if (deletedSelectedChange) {
        cache.clearDiff(deleteTarget.path, projectState?.selectedChangeKind);
      }
      if (deletedSelectedFile || deletedSelectedChange) {
        updateProjectPreview(projectId, {
          selectedFilePath: deletedSelectedFile
            ? undefined
            : projectState?.selectedFilePath,
          selectedChangePath: deletedSelectedChange
            ? undefined
            : projectState?.selectedChangePath,
          selectedChangeKind: deletedSelectedChange
            ? undefined
            : projectState?.selectedChangeKind,
        });
      }
      setDeleteTarget(null);
      refresh.treeParents([deleteTarget.path]);
      await refresh.fileSearch();
      void refresh.changes({ preserveMode: projectState?.mode !== "changes" });
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setPending(null);
    }
  });

  const submitReset = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !resetTarget || pending) {
      return;
    }
    setPending("reset");
    setError(null);
    try {
      await resetTerminalProjectPreviewChange(apiBase, token, projectId, {
        path: resetTarget.path,
        kind: resetTarget.kind,
      });
      const resetSelectedFile =
        projectState?.selectedFilePath === resetTarget.path ||
        filePreview?.path === resetTarget.path;
      const resetSelectedChange =
        projectState?.selectedChangePath === resetTarget.path &&
        projectState.selectedChangeKind === resetTarget.kind;
      if (resetSelectedFile) {
        cache.clearFile(resetTarget.path);
        editor.clear();
      }
      if (resetSelectedChange) {
        cache.clearDiff(resetTarget.path, resetTarget.kind);
      }
      if (resetSelectedFile || resetSelectedChange) {
        updateProjectPreview(projectId, {
          selectedFilePath: resetSelectedFile
            ? undefined
            : projectState?.selectedFilePath,
          selectedChangePath: resetSelectedChange
            ? undefined
            : projectState?.selectedChangePath,
          selectedChangeKind: resetSelectedChange
            ? undefined
            : projectState?.selectedChangeKind,
        });
      }
      setResetTarget(null);
      refresh.treeParents([resetTarget.path]);
      await refresh.fileSearch();
      void refresh.changes({ preserveMode: projectState?.mode !== "changes" });
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setPending(null);
    }
  });

  const closeRename = useMemoizedFn((): void => {
    setRenameTarget(null);
    setRenamePath("");
    setError(null);
  });
  const closeDelete = useMemoizedFn((): void => {
    setDeleteTarget(null);
    setError(null);
  });
  const closeReset = useMemoizedFn((): void => {
    setResetTarget(null);
    setError(null);
  });

  return {
    closeDelete,
    closeRename,
    closeReset,
    deleteTarget,
    error,
    pending,
    renamePath,
    renameTarget,
    requestDelete,
    requestRename,
    requestReset,
    resetTarget,
    setError,
    setRenamePath,
    submitDelete,
    submitRename,
    submitReset,
  };
}
