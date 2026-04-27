import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import {
  useTerminalPreviewStore,
  DEFAULT_MARKDOWN_VIEW_MODE,
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
} from "../../features/terminal/preview-store";
import {
  getTerminalPreviewFileKind,
  isSupportedTerminalImagePreviewPath,
} from "../../features/terminal/preview-file-types";
import { HttpError } from "../../services/http";
import {
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  searchTerminalProjectPreviewFiles,
} from "../../services/terminal";
import { TerminalPreviewPanelContent } from "./terminal-preview-panel-content";
import { useTerminalPreviewPanelActions } from "./terminal-preview-panel-actions";
import { TerminalPreviewPanelShell } from "./terminal-preview-panel-shell";

interface TerminalPreviewPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  widthPx?: number;
  onAuthExpired?: () => void;
  onEditProject: () => void;
}

function resolveSelectedChange(params: {
  changes: TerminalPreviewGitChangesResponse;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
}):
  | { path: string; kind: TerminalPreviewChangeKind }
  | null {
  const { changes, selectedChangeKind, selectedChangePath } = params;
  if (selectedChangePath && selectedChangeKind) {
    const candidates =
      selectedChangeKind === "staged" ? changes.staged : changes.working;
    if (candidates.some((file) => file.path === selectedChangePath)) {
      return {
        path: selectedChangePath,
        kind: selectedChangeKind,
      };
    }
  }

  if (changes.staged[0]) {
    return {
      path: changes.staged[0].path,
      kind: "staged",
    };
  }

  if (changes.working[0]) {
    return {
      path: changes.working[0].path,
      kind: "working",
    };
  }

  return null;
}

export function TerminalPreviewPanel({
  apiBase,
  token,
  activeProject,
  widthPx,
  onAuthExpired,
  onEditProject,
}: TerminalPreviewPanelProps) {
  const closePreview = useTerminalPreviewStore((state) => state.closePreview);
  const setWidth = useTerminalPreviewStore((state) => state.setWidth);
  const expanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const activeTool = useTerminalPreviewStore((state) => state.ui.activeTool);
  const setActiveTool = useTerminalPreviewStore((state) => state.setActiveTool);
  const setExpanded = useTerminalPreviewStore((state) => state.setExpanded);
  const updateProjectPreview = useTerminalPreviewStore(
    (state) => state.updateProjectPreview,
  );
  const projectState = useTerminalPreviewStore((state) =>
    activeProject ? state.projects[activeProject.projectId] : undefined,
  );
  const mode = projectState?.mode ?? null;
  const query = projectState?.openFileQuery ?? "";
  const selectedFilePath = projectState?.selectedFilePath;
  const selectedChangePath = projectState?.selectedChangePath;
  const selectedChangeKind = projectState?.selectedChangeKind;
  const markdownViewMode = projectState?.markdownViewMode ?? DEFAULT_MARKDOWN_VIEW_MODE;
  const markdownSplitSourceWidthPct =
    projectState?.markdownSplitSourceWidthPct ?? 50;
  const svgViewMode = projectState?.svgViewMode ?? "preview";
  const changesViewMode = projectState?.changesViewMode ?? "diff";
  const [searchItems, setSearchItems] = useState<TerminalPreviewFileSearchItem[]>(
    [],
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<TerminalPreviewFileResponse | null>(
    null,
  );
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [changes, setChanges] = useState<TerminalPreviewGitChangesResponse | null>(
    null,
  );
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<TerminalPreviewFileDiffResponse | null>(
    null,
  );
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const fileRequestIdRef = useRef(0);
  const changesRequestIdRef = useRef(0);
  const diffRequestIdRef = useRef(0);
  const selectedChangePathRef = useRef(selectedChangePath);
  const selectedChangeKindRef = useRef(selectedChangeKind);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [markdownScrollRatio, setMarkdownScrollRatio] = useState(0);

  const projectId = activeProject?.projectId ?? null;
  const hasProjectPath = Boolean(activeProject?.path);
  const absoluteInput = query.trim().startsWith("/");
  const panelWidth = expanded
    ? "100%"
    : widthPx
      ? `${widthPx}px`
      : DEFAULT_TERMINAL_SIDECAR_WIDTH;
  const fileKind = selectedFilePath
    ? getTerminalPreviewFileKind(selectedFilePath, filePreview?.language)
    : "text";

  const handleRequestError = useCallback(
    (error: unknown): string => {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
      }
      return error instanceof Error ? error.message : String(error);
    },
    [onAuthExpired],
  );

  const loadFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (!projectId) {
        return;
      }
      const requestId = fileRequestIdRef.current + 1;
      fileRequestIdRef.current = requestId;
      setFileLoading(true);
      setFileError(null);
      setFilePreview(null);
      try {
        const payload = await getTerminalProjectPreviewFile(
          apiBase,
          token,
          projectId,
          filePath,
        );
        if (fileRequestIdRef.current !== requestId) {
          return;
        }
        setFilePreview(payload);
      } catch (error) {
        if (fileRequestIdRef.current !== requestId) {
          return;
        }
        setFilePreview(null);
        setFileError(handleRequestError(error));
      } finally {
        if (fileRequestIdRef.current === requestId) {
          setFileLoading(false);
        }
      }
    },
    [apiBase, handleRequestError, projectId, token],
  );

  const loadDiff = useCallback(
    async (filePath: string, kind: TerminalPreviewChangeKind): Promise<void> => {
      if (!projectId) {
        return;
      }
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      setDiffLoading(true);
      setDiffError(null);
      try {
        const payload = await getTerminalProjectPreviewFileDiff(
          apiBase,
          token,
          projectId,
          { path: filePath, kind },
        );
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        setFileDiff(payload);
      } catch (error) {
        if (diffRequestIdRef.current !== requestId) {
          return;
        }
        setFileDiff(null);
        setDiffError(handleRequestError(error));
      } finally {
        if (diffRequestIdRef.current === requestId) {
          setDiffLoading(false);
        }
      }
    },
    [apiBase, handleRequestError, projectId, token],
  );

  const loadChanges = useCallback(async (options?: {
    reloadDiff?: boolean;
  }): Promise<void> => {
    if (!projectId) {
      return;
    }
    const reloadDiff = options?.reloadDiff ?? true;
    const requestId = changesRequestIdRef.current + 1;
    changesRequestIdRef.current = requestId;
    setChangesLoading(true);
    setChangesError(null);
    try {
      const payload = await getTerminalProjectPreviewGitChanges(
        apiBase,
        token,
        projectId,
      );
      if (changesRequestIdRef.current !== requestId) {
        return;
      }
      setChanges(payload);
      const selected = resolveSelectedChange({
        changes: payload,
        selectedChangePath: selectedChangePathRef.current,
        selectedChangeKind: selectedChangeKindRef.current,
      });
      if (!selected) {
        diffRequestIdRef.current += 1;
        setFileDiff(null);
        setDiffError(null);
        setDiffLoading(false);
        updateProjectPreview(projectId, {
          mode: "changes",
          selectedChangePath: undefined,
          selectedChangeKind: undefined,
        });
        return;
      }

      const selectedChanged =
        selected.path !== selectedChangePathRef.current ||
        selected.kind !== selectedChangeKindRef.current;
      if (selectedChanged) {
        updateProjectPreview(projectId, {
          mode: "changes",
          selectedChangePath: selected.path,
          selectedChangeKind: selected.kind,
        });
        return;
      }
      if (reloadDiff) {
        void loadDiff(selected.path, selected.kind);
      }
    } catch (error) {
      if (changesRequestIdRef.current !== requestId) {
        return;
      }
      setChangesError(handleRequestError(error));
    } finally {
      if (changesRequestIdRef.current === requestId) {
        setChangesLoading(false);
      }
    }
  }, [
    apiBase,
    handleRequestError,
    loadDiff,
    projectId,
    token,
    updateProjectPreview,
  ]);

  useEffect(() => {
    fileRequestIdRef.current += 1;
    changesRequestIdRef.current += 1;
    diffRequestIdRef.current += 1;
    setSearchItems([]);
    setSearchError(null);
    setFilePreview(null);
    setFileError(null);
    setChanges(null);
    setChangesError(null);
    setFileDiff(null);
    setDiffError(null);
  }, [projectId]);

  useEffect(() => {
    selectedChangePathRef.current = selectedChangePath;
    selectedChangeKindRef.current = selectedChangeKind;
  }, [selectedChangeKind, selectedChangePath]);

  useEffect(() => {
    if (!projectId || !hasProjectPath || mode) {
      return;
    }
    updateProjectPreview(projectId, { mode: "changes" });
  }, [hasProjectPath, mode, projectId, updateProjectPreview]);

  useEffect(() => {
    if (mode !== "file" || !selectedFilePath) {
      return;
    }
    if (isSupportedTerminalImagePreviewPath(selectedFilePath)) {
      fileRequestIdRef.current += 1;
      setFilePreview(null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    void loadFile(selectedFilePath);
  }, [loadFile, mode, selectedFilePath]);

  useEffect(() => {
    if (mode !== "changes" || !hasProjectPath || !projectId) {
      return;
    }
    void loadChanges({
      reloadDiff:
        !selectedChangePathRef.current || !selectedChangeKindRef.current,
    });
  }, [hasProjectPath, loadChanges, mode, projectId]);

  useEffect(() => {
    if (mode !== "changes" || !selectedChangePath || !selectedChangeKind) {
      return;
    }
    void loadDiff(selectedChangePath, selectedChangeKind);
  }, [loadDiff, mode, selectedChangeKind, selectedChangePath]);

  useEffect(() => {
    if (
      mode !== "file" ||
      !projectId ||
      absoluteInput
    ) {
      setSearchItems([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    setSearchItems([]);
    const timeoutId = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      searchTerminalProjectPreviewFiles(apiBase, token, projectId, {
        query,
        limit: 50,
      })
        .then((payload) => {
          if (!abort.signal.aborted) {
            setSearchItems(payload.items);
          }
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) {
            setSearchError(handleRequestError(error));
          }
        })
        .finally(() => {
          if (!abort.signal.aborted) {
            setSearchLoading(false);
          }
        });
    }, 250);

    return () => {
      abort.abort();
      window.clearTimeout(timeoutId);
    };
  }, [
    absoluteInput,
    apiBase,
    handleRequestError,
    mode,
    projectId,
    query,
    token,
  ]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded, setExpanded]);

  const selectedPath = useMemo(() => {
    if (mode === "file") {
      return selectedFilePath ?? filePreview?.path ?? null;
    }
    if (mode === "changes") {
      return selectedChangePath ?? fileDiff?.path ?? null;
    }
    return null;
  }, [fileDiff?.path, filePreview?.path, mode, selectedChangePath, selectedFilePath]);

  const {
    copyPath,
    openFilePath,
    refresh,
    setChangesViewMode,
    setMarkdownViewMode,
    setSvgViewMode,
    startMarkdownResize,
    startResize,
  } = useTerminalPreviewPanelActions({
    expanded,
    mode,
    projectId,
    query,
    selectedFilePath,
    selectedPath,
    loadFile: async (filePath) => {
      if (isSupportedTerminalImagePreviewPath(filePath)) {
        setAssetRefreshKey((current) => current + 1);
        return;
      }
      await loadFile(filePath);
    },
    loadChanges,
    setWidth,
    updateProjectPreview,
    setFilePreview: () => setFilePreview(null),
    setFileError,
    setMarkdownScrollRatio,
  });

  const body = (
    <TerminalPreviewPanelContent
      activeProject={activeProject}
      apiBase={apiBase}
      token={token}
      mode={mode}
      projectId={projectId}
      hasProjectPath={hasProjectPath}
      query={query}
      absoluteInput={absoluteInput}
      selectedFilePath={selectedFilePath}
      selectedChangePath={selectedChangePath}
      selectedChangeKind={selectedChangeKind}
      markdownViewMode={markdownViewMode}
      markdownSplitSourceWidthPct={markdownSplitSourceWidthPct}
      svgViewMode={svgViewMode}
      changesViewMode={changesViewMode}
      searchItems={searchItems}
      searchLoading={searchLoading}
      searchError={searchError}
      filePreview={filePreview}
      fileLoading={fileLoading}
      fileError={fileError}
      changes={changes}
      changesLoading={changesLoading}
      changesError={changesError}
      fileDiff={fileDiff}
      diffLoading={diffLoading}
      diffError={diffError}
      assetRefreshKey={assetRefreshKey}
      markdownScrollRatio={markdownScrollRatio}
      onAuthExpired={onAuthExpired}
      onEditProject={onEditProject}
      onQueryChange={(nextQuery) => {
        if (projectId) {
          updateProjectPreview(projectId, {
            mode: "file",
            openFileQuery: nextQuery,
            selectedFilePath: undefined,
          });
        }
      }}
      onOpenFilePath={openFilePath}
      onSelectChange={(filePath, kind) => {
        if (!projectId) {
          return;
        }
        updateProjectPreview(projectId, {
          mode: "changes",
          selectedChangePath: filePath,
          selectedChangeKind: kind,
        });
      }}
      onReloadDiff={(filePath, kind) => {
        void loadDiff(filePath, kind);
      }}
      onMarkdownScrollRatioChange={setMarkdownScrollRatio}
      onStartMarkdownResize={startMarkdownResize}
      onOpenModeFile={() => {
        if (projectId) {
          updateProjectPreview(projectId, { mode: "file" });
        }
      }}
      onOpenModeChanges={() => {
        if (projectId) {
          updateProjectPreview(projectId, { mode: "changes" });
        }
      }}
    />
  );

  return (
    <TerminalPreviewPanelShell
      panelWidth={panelWidth}
      expanded={expanded}
      activeTool={activeTool}
      mode={mode}
      fileKind={
        mode === "changes" && selectedChangePath
          ? getTerminalPreviewFileKind(selectedChangePath, null)
          : fileKind
      }
      fileLoading={fileLoading}
      changesLoading={changesLoading}
      selectedPath={selectedPath}
      markdownViewMode={markdownViewMode}
      svgViewMode={svgViewMode}
      changesViewMode={changesViewMode}
      selectedChangePath={selectedChangePath}
      activeProject={activeProject}
      body={body}
      onStartResize={startResize}
      onSetActiveTool={setActiveTool}
      onSetPreviewMode={(nextMode) => {
        if (projectId) {
          updateProjectPreview(projectId, { mode: nextMode });
        }
      }}
      onToggleExpanded={() => setExpanded(!expanded)}
      onRefresh={refresh}
      onCopyPath={copyPath}
      onClosePreview={closePreview}
      onSetMarkdownViewMode={setMarkdownViewMode}
      onSetSvgViewMode={setSvgViewMode}
      onSetChangesViewMode={setChangesViewMode}
    />
  );
}
