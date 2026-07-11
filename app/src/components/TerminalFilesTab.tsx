import { useMemoizedFn } from "ahooks";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type {
  TerminalPreviewGitChangesResponse,
  TerminalPreviewGitStatus,
  TerminalPreviewTreeEntry,
} from "@runweave/shared/terminal/preview";

import {
  basenameOf,
  dirnameOf,
  languageBadgeFor,
  parentPathOf,
} from "../lib/terminal-file-format";
import { ApiError } from "../services/http";
import {
  getTerminalProjectPreviewGitChanges,
  listTerminalProjectPreviewDirectory,
  searchTerminalProjectPreviewFiles,
} from "../services/terminal";
import type { SelectedTerminalChange } from "./TerminalChangesTab";
import {
  type FileChangeInfo,
  TerminalFilePreviewDrawer,
} from "./TerminalFilePreviewDrawer";
import { appQueryKeys } from "../features/query/app-query-provider";
import { useAppTerminalRuntime } from "../features/terminal/app-terminal-runtime";

function previewMessage(status: number): string {
  if (status === 404) {
    return "Project not found";
  }
  if (status === 409) {
    return "Set a project path to use Changes and Files";
  }
  return "Unable to load files";
}

function statusLabel(status: TerminalPreviewGitStatus): string {
  if (status === "added") {
    return "A";
  }
  if (status === "modified") {
    return "M";
  }
  if (status === "deleted") {
    return "D";
  }
  if (status === "renamed") {
    return "R";
  }
  if (status === "copied") {
    return "C";
  }
  if (status === "untracked") {
    return "U";
  }
  return "?";
}

function buildChangeMap(
  changes: TerminalPreviewGitChangesResponse | null,
): Map<string, FileChangeInfo> {
  const map = new Map<string, FileChangeInfo>();
  if (!changes) {
    return map;
  }
  for (const change of changes.staged) {
    map.set(change.path, { kind: "staged", status: change.status });
  }
  for (const change of changes.working) {
    map.set(change.path, { kind: "working", status: change.status });
  }
  return map;
}

function sortEntries(
  entries: TerminalPreviewTreeEntry[],
): TerminalPreviewTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.basename.localeCompare(right.basename);
  });
}

function Breadcrumb({
  path,
  onOpenDirectory,
}: {
  path: string;
  onOpenDirectory: (path: string) => void;
}) {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [
    { label: "root", path: "" },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
    })),
  ];

  return (
    <nav
      aria-label="Directory breadcrumb"
      className="terminal-files-breadcrumb"
    >
      {crumbs.map((crumb, index) => {
        const isCurrent = index === crumbs.length - 1;
        return (
          <span className="terminal-files-breadcrumb__item" key={crumb.path}>
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="terminal-files-breadcrumb__separator"
              >
                /
              </span>
            ) : null}
            <button
              aria-current={isCurrent ? "page" : undefined}
              className={isCurrent ? "is-current" : ""}
              onClick={() => onOpenDirectory(crumb.path)}
              type="button"
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function ChangeBadge({ info }: { info: FileChangeInfo | null }) {
  if (!info) {
    return null;
  }
  return (
    <span className={`terminal-change-badge is-${info.status}`}>
      {statusLabel(info.status)}
    </span>
  );
}

export function TerminalFilesTab({
  active,
  onShowChanges,
}: {
  active: boolean;
  onShowChanges: (change: SelectedTerminalChange) => void;
}) {
  const { accessToken, apiBase, onAuthExpired, projectId, scope } =
    useAppTerminalRuntime();
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const directoryQuery = useQuery({
    queryKey: projectId
      ? appQueryKeys.terminalDirectory(scope, projectId, path)
      : [...appQueryKeys.all(scope), "terminal-preview", "no-directory"],
    queryFn: () =>
      listTerminalProjectPreviewDirectory(apiBase, accessToken, projectId!, {
        path,
        limit: 400,
      }),
    enabled: active && Boolean(projectId),
  });
  const changesQuery = useQuery({
    queryKey: projectId
      ? appQueryKeys.terminalChanges(scope, projectId)
      : [...appQueryKeys.all(scope), "terminal-preview", "no-project"],
    queryFn: () =>
      getTerminalProjectPreviewGitChanges(apiBase, accessToken, projectId!),
    enabled: active && Boolean(projectId),
  });
  const searchQuery = useQuery({
    queryKey:
      projectId && debouncedQuery
        ? appQueryKeys.terminalFileSearch(scope, projectId, debouncedQuery)
        : [...appQueryKeys.all(scope), "terminal-preview", "no-search"],
    queryFn: () =>
      searchTerminalProjectPreviewFiles(apiBase, accessToken, projectId!, {
        query: debouncedQuery,
        limit: 50,
      }),
    enabled: active && Boolean(projectId && debouncedQuery),
  });
  const directory = directoryQuery.data ?? null;
  const changes = changesQuery.data ?? null;
  const searchItems = searchQuery.data?.items ?? [];
  const loading = directoryQuery.isFetching;
  const searchLoading = searchQuery.isFetching;
  const error = directoryQuery.error
    ? directoryQuery.error instanceof ApiError
      ? previewMessage(directoryQuery.error.status)
      : directoryQuery.error instanceof Error
        ? directoryQuery.error.message
        : "Load failed"
    : null;
  const searchError = searchQuery.error
    ? searchQuery.error instanceof Error
      ? searchQuery.error.message
      : "Search failed"
    : null;
  const changeMap = useMemo(() => buildChangeMap(changes), [changes]);

  useEffect(() => {
    setPath("");
    setQuery("");
    setDebouncedQuery("");
    setPreviewPath(null);
  }, [projectId]);

  const loadChanges = useMemoizedFn(() => {
    if (projectId) void changesQuery.refetch();
  });

  const loadDirectory = useMemoizedFn(() => {
    if (projectId) void directoryQuery.refetch();
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (
      [directoryQuery.error, changesQuery.error, searchQuery.error].some(
        (nextError) =>
          nextError instanceof ApiError && nextError.status === 401,
      )
    ) {
      onAuthExpired();
    }
  }, [
    changesQuery.error,
    directoryQuery.error,
    onAuthExpired,
    searchQuery.error,
  ]);

  const entries = useMemo(
    () => sortEntries(directory?.entries ?? []),
    [directory?.entries],
  );

  if (!projectId) {
    return (
      <section className="terminal-preview-pane">
        <p className="terminal-preview-empty">
          Set a project path to use Changes and Files
        </p>
      </section>
    );
  }

  if (previewPath) {
    return (
      <TerminalFilePreviewDrawer
        changeInfo={changeMap.get(previewPath) ?? null}
        filePath={previewPath}
        onClose={() => setPreviewPath(null)}
        onShowChanges={(change) => {
          setPreviewPath(null);
          onShowChanges(change);
        }}
      />
    );
  }

  return (
    <section className="terminal-preview-pane terminal-files-pane">
      <header className="terminal-preview-header">
        <div>
          <h2>Files</h2>
          <p>{path || "Project root"}</p>
        </div>
        <button
          className="terminal-preview-action"
          disabled={loading}
          onClick={() => {
            loadDirectory();
            loadChanges();
          }}
          type="button"
        >
          Refresh
        </button>
      </header>
      <input
        aria-label="Search files"
        className="terminal-files-search"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search files"
        value={query}
      />
      {debouncedQuery ? null : (
        <Breadcrumb path={path} onOpenDirectory={setPath} />
      )}
      {debouncedQuery ? (
        <div className="terminal-file-list">
          {searchLoading ? (
            <p className="terminal-preview-empty">Searching...</p>
          ) : searchError ? (
            <p className="terminal-preview-empty">{searchError}</p>
          ) : searchItems.length === 0 ? (
            <p className="terminal-preview-empty">No files found.</p>
          ) : (
            searchItems.map((item) => {
              const info =
                changeMap.get(item.path) ??
                (item.gitStatus
                  ? { kind: "working" as const, status: item.gitStatus }
                  : null);
              return (
                <button
                  className="terminal-file-row"
                  key={item.path}
                  onClick={() => setPreviewPath(item.path)}
                  type="button"
                >
                  <span className="terminal-file-row__badge">
                    {languageBadgeFor(item.path)}
                  </span>
                  <span className="terminal-file-row__name">
                    <strong>{item.basename}</strong>
                    <small>{item.dirname}</small>
                  </span>
                  <ChangeBadge info={info} />
                </button>
              );
            })
          )}
        </div>
      ) : loading ? (
        <p className="terminal-preview-empty">Loading files...</p>
      ) : error ? (
        <div className="terminal-preview-state">
          <p>{error}</p>
          <button onClick={loadDirectory} type="button">
            Retry
          </button>
        </div>
      ) : (
        <div className="terminal-file-list">
          {path ? (
            <button
              className="terminal-file-row"
              onClick={() => setPath(parentPathOf(path))}
              type="button"
            >
              <span className="terminal-file-row__badge">..</span>
              <span className="terminal-file-row__name">
                <strong>Parent directory</strong>
                <small>{parentPathOf(path) || "root"}</small>
              </span>
            </button>
          ) : null}
          {entries.map((entry) => {
            const info = changeMap.get(entry.path) ?? null;
            return (
              <button
                className="terminal-file-row"
                key={`${entry.kind}:${entry.path}`}
                onClick={() =>
                  entry.kind === "directory"
                    ? setPath(entry.path)
                    : setPreviewPath(entry.path)
                }
                type="button"
              >
                <span className="terminal-file-row__badge">
                  {entry.kind === "directory"
                    ? "DIR"
                    : languageBadgeFor(entry.path)}
                </span>
                <span className="terminal-file-row__name">
                  <strong>{basenameOf(entry.path)}</strong>
                  <small>
                    {entry.kind === "directory"
                      ? entry.path
                      : dirnameOf(entry.path)}
                  </small>
                </span>
                <ChangeBadge info={info} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
