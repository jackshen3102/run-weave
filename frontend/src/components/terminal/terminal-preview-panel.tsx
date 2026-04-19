import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useRef,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewGitChangesResponse,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import { Copy, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import {
  useTerminalPreviewStore,
  DEFAULT_MARKDOWN_VIEW_MODE,
  type TerminalChangesViewMode,
  type TerminalMarkdownViewMode,
  type TerminalSvgViewMode,
} from "../../features/terminal/preview-store";
import {
  getTerminalPreviewFileKind,
  getTerminalPreviewMonacoLanguage,
  extensionToLanguageHint,
  isSupportedTerminalImagePreviewPath,
} from "../../features/terminal/preview-file-types";
import { HttpError } from "../../services/http";
import {
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  searchTerminalProjectPreviewFiles,
} from "../../services/terminal";
import { Button } from "../ui/button";
import { TerminalOpenFileCommand } from "./terminal-open-file-command";

const TerminalMonacoViewer = lazy(() =>
  import("./terminal-monaco-viewer").then((module) => ({
    default: module.TerminalMonacoViewer,
  })),
);

const TerminalMarkdownPreview = lazy(() =>
  import("./terminal-markdown-preview").then((module) => ({
    default: module.TerminalMarkdownPreview,
  })),
);

const TerminalSvgPreview = lazy(() =>
  import("./terminal-svg-preview").then((module) => ({
    default: module.TerminalSvgPreview,
  })),
);

const TerminalImagePreview = lazy(() =>
  import("./terminal-image-preview").then((module) => ({
    default: module.TerminalImagePreview,
  })),
);

interface TerminalPreviewPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  widthPx?: number;
  onAuthExpired?: () => void;
  onEditProject: () => void;
}

function describeMode(mode: string | null | undefined): string {
  if (mode === "file") {
    return "Open file";
  }
  if (mode === "changes") {
    return "Changes";
  }
  return "Preview";
}

function statusBadge(status: TerminalPreviewChangeFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "modified":
      return "M";
    default:
      return "?";
  }
}

function basename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function dirname(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
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
  const diffRequestIdRef = useRef(0);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [markdownScrollRatio, setMarkdownScrollRatio] = useState(0);

  const projectId = activeProject?.projectId ?? null;
  const hasProjectPath = Boolean(activeProject?.path);
  const absoluteInput = query.trim().startsWith("/");
  const panelWidth = expanded
    ? "100%"
    : widthPx
      ? `${widthPx}px`
      : "clamp(320px, 50vw, 60vw)";
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

  const loadChanges = useCallback(async (): Promise<void> => {
    if (!projectId) {
      return;
    }
    setChangesLoading(true);
    setChangesError(null);
    setFileDiff(null);
    setDiffError(null);
    try {
      const payload = await getTerminalProjectPreviewGitChanges(
        apiBase,
        token,
        projectId,
      );
      setChanges(payload);
      const selected =
        payload.staged[0] ?? payload.working[0] ?? null;
      if (selected) {
        updateProjectPreview(projectId, {
          mode: "changes",
          selectedChangePath: selected.path,
          selectedChangeKind: payload.staged[0] ? "staged" : "working",
        });
      }
    } catch (error) {
      setChanges(null);
      setChangesError(handleRequestError(error));
    } finally {
      setChangesLoading(false);
    }
  }, [
    apiBase,
    handleRequestError,
    projectId,
    token,
    updateProjectPreview,
  ]);

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

  useEffect(() => {
    fileRequestIdRef.current += 1;
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
    void loadChanges();
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
      selectedFilePath ||
      !projectId ||
      !query.trim() ||
      absoluteInput
    ) {
      return;
    }
    const abort = new AbortController();
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
    selectedFilePath,
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

  const refresh = (): void => {
    if (mode === "file") {
      if (selectedFilePath) {
        if (isSupportedTerminalImagePreviewPath(selectedFilePath)) {
          setAssetRefreshKey((current) => current + 1);
          return;
        }
        void loadFile(selectedFilePath);
      } else if (projectId) {
        updateProjectPreview(projectId, { openFileQuery: query });
      }
      return;
    }
    if (mode === "changes") {
      void loadChanges();
    }
  };

  const copyPath = (): void => {
    if (!selectedPath) {
      return;
    }
    void navigator.clipboard?.writeText(selectedPath);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (expanded) {
      return;
    }
    event.preventDefault();
    const handlePointerMove = (moveEvent: globalThis.PointerEvent): void => {
      const nextWidth = Math.min(
        Math.round(window.innerWidth * 0.6),
        Math.max(320, window.innerWidth - moveEvent.clientX),
      );
      setWidth(nextWidth);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stop);
  };

  const openFilePath = (filePath: string): void => {
    if (!projectId) {
      return;
    }
    updateProjectPreview(projectId, {
      mode: "file",
      selectedFilePath: filePath,
      path: filePath,
    });
    setFilePreview(null);
    setFileError(null);
    setMarkdownScrollRatio(0);
  };

  const setMarkdownViewMode = (nextMode: TerminalMarkdownViewMode): void => {
    if (!projectId) {
      return;
    }
    updateProjectPreview(projectId, { markdownViewMode: nextMode });
  };

  const setSvgViewMode = (nextMode: TerminalSvgViewMode): void => {
    if (!projectId) {
      return;
    }
    updateProjectPreview(projectId, { svgViewMode: nextMode });
  };

  const setChangesViewMode = (nextMode: TerminalChangesViewMode): void => {
    if (!projectId) {
      return;
    }
    updateProjectPreview(projectId, { changesViewMode: nextMode });
  };

  const startMarkdownResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (!projectId) {
      return;
    }
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    const handlePointerMove = (moveEvent: globalThis.PointerEvent): void => {
      const rect = container?.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        return;
      }
      const nextPct = Math.min(
        70,
        Math.max(30, ((moveEvent.clientX - rect.left) / rect.width) * 100),
      );
      updateProjectPreview(projectId, {
        markdownSplitSourceWidthPct: Math.round(nextPct),
      });
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stop);
  };

  const renderEmpty = (title: string, action?: ReactNode): ReactNode => (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-slate-400">
      <p>{title}</p>
      {action}
    </div>
  );

  const renderChangesList = (
    title: string,
    kind: TerminalPreviewChangeKind,
    files: TerminalPreviewChangeFile[],
  ): ReactNode => (
    <div className="flex flex-col gap-1">
      <div className="px-2 py-1 text-[11px] uppercase tracking-[0.22em] text-slate-500">
        {title}
      </div>
      {files.map((file) => {
        const selected =
          selectedChangePath === file.path && selectedChangeKind === kind;
        return (
          <button
            type="button"
            key={`${kind}:${file.path}`}
            className={[
              "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm",
              selected
                ? "bg-slate-800 text-slate-100"
                : "text-slate-300 hover:bg-slate-900",
            ].join(" ")}
            onClick={() => {
              if (!projectId) {
                return;
              }
              updateProjectPreview(projectId, {
                mode: "changes",
                selectedChangePath: file.path,
                selectedChangeKind: kind,
              });
            }}
          >
            <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
              {statusBadge(file.status)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{basename(file.path)}</span>
              {dirname(file.path) ? (
                <span className="block truncate text-xs text-slate-500">
                  {dirname(file.path)}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );

  let body: ReactNode;
  if (!activeProject) {
    body = renderEmpty("No project selected");
  } else if (!hasProjectPath) {
    body = renderEmpty(
      "Set a project path to use Preview",
      <Button
        type="button"
        size="sm"
        className="rounded-lg"
        onClick={onEditProject}
      >
        Set project path
      </Button>,
    );
  } else if (mode === "file" && !selectedFilePath) {
    body = (
      <TerminalOpenFileCommand
        query={query}
        loading={searchLoading}
        error={searchError}
        items={searchItems}
        absoluteInput={absoluteInput}
        onQueryChange={(nextQuery) => {
          if (projectId) {
            updateProjectPreview(projectId, {
              mode: "file",
              openFileQuery: nextQuery,
              selectedFilePath: undefined,
            });
          }
        }}
        onOpenPath={openFilePath}
      />
    );
  } else if (mode === "file") {
    const monacoLanguage = getTerminalPreviewMonacoLanguage(filePreview?.language);
    body = (
      <div className="h-full min-h-0">
        {fileKind === "image" && selectedFilePath && projectId ? (
          <Suspense fallback={renderEmpty("Loading image preview...")}>
            <TerminalImagePreview
              apiBase={apiBase}
              token={token}
              projectId={projectId}
              path={selectedFilePath}
              refreshKey={assetRefreshKey}
              onAuthExpired={onAuthExpired}
            />
          </Suspense>
        ) : fileLoading ? (
          renderEmpty("Loading preview...")
        ) : fileError ? (
          renderEmpty(fileError)
        ) : filePreview && fileKind === "markdown" ? (
          markdownViewMode === "source" ? (
            <Suspense fallback={renderEmpty("Loading editor...")}>
              <TerminalMonacoViewer
                language="markdown"
                content={filePreview.content}
              />
            </Suspense>
          ) : markdownViewMode === "preview" ? (
            <Suspense fallback={renderEmpty("Loading markdown preview...")}>
              <TerminalMarkdownPreview
                apiBase={apiBase}
                token={token}
                projectId={activeProject.projectId}
                content={filePreview.content}
                path={filePreview.path}
                onAuthExpired={onAuthExpired}
                onOpenFile={openFilePath}
              />
            </Suspense>
          ) : (
            <div
              className="grid h-full min-h-0"
              style={{
                gridTemplateColumns: `${markdownSplitSourceWidthPct}% 4px minmax(0, 1fr)`,
              }}
            >
              <Suspense fallback={renderEmpty("Loading editor...")}>
                <TerminalMonacoViewer
                  language="markdown"
                  content={filePreview.content}
                  scrollRatio={markdownScrollRatio}
                  onScrollRatioChange={setMarkdownScrollRatio}
                />
              </Suspense>
              <div
                role="separator"
                aria-orientation="vertical"
                className="cursor-col-resize bg-slate-900 hover:bg-slate-700"
                onPointerDown={startMarkdownResize}
              />
              <Suspense fallback={renderEmpty("Loading markdown preview...")}>
                <TerminalMarkdownPreview
                  apiBase={apiBase}
                  token={token}
                  projectId={activeProject.projectId}
                  content={filePreview.content}
                  path={filePreview.path}
                  scrollRatio={markdownScrollRatio}
                  onScrollRatioChange={setMarkdownScrollRatio}
                  onAuthExpired={onAuthExpired}
                  onOpenFile={openFilePath}
                />
              </Suspense>
            </div>
          )
        ) : filePreview && fileKind === "svg" ? (
          svgViewMode === "source" ? (
            <Suspense fallback={renderEmpty("Loading editor...")}>
              <TerminalMonacoViewer
                language="xml"
                content={filePreview.content}
              />
            </Suspense>
          ) : (
            <Suspense fallback={renderEmpty("Loading SVG preview...")}>
              <TerminalSvgPreview content={filePreview.content} />
            </Suspense>
          )
        ) : filePreview ? (
          <Suspense fallback={renderEmpty("Loading editor...")}>
            <TerminalMonacoViewer
              language={monacoLanguage}
              content={filePreview.content}
            />
          </Suspense>
        ) : (
          renderEmpty("No file selected")
        )}
      </div>
    );
  } else if (mode === "changes") {
    const noChanges =
      changes && changes.staged.length === 0 && changes.working.length === 0;
    const changeDiffFileKind = selectedChangePath
      ? getTerminalPreviewFileKind(selectedChangePath, null)
      : "text";
    const changeDiffLanguageHint = selectedChangePath
      ? extensionToLanguageHint(selectedChangePath)
      : null;
    const changeDiffMonacoLanguage = getTerminalPreviewMonacoLanguage(changeDiffLanguageHint);
    const isChangeImageDeleted =
      changeDiffFileKind === "image" && fileDiff?.status === "deleted";

    let changeContent: ReactNode;
    if (diffLoading) {
      changeContent = renderEmpty("Loading diff...");
    } else if (diffError) {
      changeContent = renderEmpty(diffError);
    } else if (!fileDiff) {
      changeContent = renderEmpty("Select a changed file");
    } else if (changeDiffFileKind === "image") {
      if (isChangeImageDeleted) {
        changeContent = renderEmpty("Image deleted");
      } else if (selectedChangePath && projectId) {
        changeContent = (
          <Suspense fallback={renderEmpty("Loading image preview...")}>
            <TerminalImagePreview
              apiBase={apiBase}
              token={token}
              projectId={projectId}
              path={selectedChangePath}
              refreshKey={0}
              onAuthExpired={onAuthExpired}
            />
          </Suspense>
        );
      } else {
        changeContent = renderEmpty("Binary file");
      }
    } else if (
      changesViewMode === "preview" &&
      changeDiffFileKind === "markdown" &&
      activeProject
    ) {
      changeContent = (
        <Suspense fallback={renderEmpty("Loading markdown preview...")}>
          <TerminalMarkdownPreview
            apiBase={apiBase}
            token={token}
            projectId={activeProject.projectId}
            content={fileDiff.newContent}
            path={fileDiff.path}
            onAuthExpired={onAuthExpired}
            onOpenFile={openFilePath}
          />
        </Suspense>
      );
    } else if (
      changesViewMode === "preview" &&
      changeDiffFileKind === "svg"
    ) {
      changeContent = (
        <Suspense fallback={renderEmpty("Loading SVG preview...")}>
          <TerminalSvgPreview content={fileDiff.newContent} />
        </Suspense>
      );
    } else {
      changeContent = (
        <Suspense fallback={renderEmpty("Loading editor...")}>
          <TerminalMonacoViewer
            diff
            language={changeDiffMonacoLanguage}
            oldContent={fileDiff.oldContent}
            newContent={fileDiff.newContent}
          />
        </Suspense>
      );
    }

    body = (
      <div className="grid h-full min-h-0 grid-cols-[190px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-r border-slate-800 p-2">
          {changesLoading ? (
            <div className="px-2 py-4 text-sm text-slate-400">Loading changes...</div>
          ) : changesError ? (
            <div className="px-2 py-4 text-sm text-rose-300">{changesError}</div>
          ) : noChanges ? (
            <div className="px-2 py-4 text-sm text-slate-400">No changes</div>
          ) : changes ? (
            <div className="flex flex-col gap-3">
              {renderChangesList("Staged Changes", "staged", changes.staged)}
              {renderChangesList("Working Changes", "working", changes.working)}
            </div>
          ) : null}
        </aside>
        <div className="min-h-0">{changeContent}</div>
      </div>
    );
  } else {
    body = renderEmpty(
      "No preview for this project",
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="rounded-lg"
          onClick={() => {
            if (projectId) {
              updateProjectPreview(projectId, { mode: "file" });
            }
          }}
        >
          Open file...
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-lg"
          onClick={() => {
            if (projectId) {
              updateProjectPreview(projectId, { mode: "changes" });
            }
          }}
        >
          Changes
        </Button>
      </div>,
    );
  }

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 border-l border-slate-800 bg-slate-950"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className={[
          "absolute left-0 top-0 h-full w-1",
          expanded ? "" : "cursor-col-resize hover:bg-slate-600",
        ].join(" ")}
        onPointerDown={startResize}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-slate-800 px-3 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-slate-100">
                  {describeMode(mode)}
                </h2>
                <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                  Read only
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-slate-500">
                {activeProject?.name ?? "No project"}
                {activeProject?.path ? ` · root: ${activeProject.path}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 rounded-lg px-2"
                onClick={() => setExpanded(!expanded)}
                aria-label={expanded ? "Restore preview" : "Expand preview"}
              >
                {expanded ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 rounded-lg px-2"
                disabled={!mode || fileLoading || changesLoading}
                onClick={refresh}
                aria-label="Refresh preview"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 rounded-lg px-2"
                disabled={!selectedPath}
                onClick={copyPath}
                aria-label="Copy path"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 rounded-lg px-2"
                onClick={closePreview}
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>
        {selectedPath ? (
          <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
            <span className="min-w-0 flex-1 truncate">{selectedPath}</span>
            {mode === "file" && fileKind === "markdown" ? (
              <div className="flex shrink-0 rounded-lg border border-slate-800 p-0.5">
                {(["source", "split", "preview"] as const).map((viewMode) => (
                  <button
                    type="button"
                    key={viewMode}
                    className={[
                      "rounded-md px-2 py-0.5 capitalize",
                      markdownViewMode === viewMode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => setMarkdownViewMode(viewMode)}
                  >
                    {viewMode}
                  </button>
                ))}
              </div>
            ) : null}
            {mode === "file" && fileKind === "svg" ? (
              <div className="flex shrink-0 rounded-lg border border-slate-800 p-0.5">
                {(["preview", "source"] as const).map((viewMode) => (
                  <button
                    type="button"
                    key={viewMode}
                    className={[
                      "rounded-md px-2 py-0.5 capitalize",
                      svgViewMode === viewMode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => setSvgViewMode(viewMode)}
                  >
                    {viewMode}
                  </button>
                ))}
              </div>
            ) : null}
            {mode === "changes" &&
            selectedChangePath &&
            (getTerminalPreviewFileKind(selectedChangePath, null) === "markdown" ||
              getTerminalPreviewFileKind(selectedChangePath, null) === "svg") ? (
              <div className="flex shrink-0 rounded-lg border border-slate-800 p-0.5">
                {(["diff", "preview"] as const).map((viewMode) => (
                  <button
                    type="button"
                    key={viewMode}
                    className={[
                      "rounded-md px-2 py-0.5 capitalize",
                      changesViewMode === viewMode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => setChangesViewMode(viewMode)}
                  >
                    {viewMode}
                  </button>
                ))}
              </div>
            ) : null}
            {mode === "file" ? (
              <button
                type="button"
                className="shrink-0 rounded-lg px-2 py-1 text-slate-300 hover:bg-slate-800"
                onClick={() => {
                  if (projectId) {
                    updateProjectPreview(projectId, {
                      mode: "file",
                      selectedFilePath: undefined,
                    });
                    setFilePreview(null);
                    setFileError(null);
                  }
                }}
              >
                Open another...
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    </aside>
  );
}
