import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  TerminalPreviewDirectoryResponse,
  TerminalPreviewFileSearchItem,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewGitStatus,
  TerminalPreviewTreeEntry,
} from "@runweave/shared";
import { createTerminalPreviewRequestSequencer } from "@runweave/shared";

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

function sortEntries(entries: TerminalPreviewTreeEntry[]): TerminalPreviewTreeEntry[] {
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
    <nav aria-label="Directory breadcrumb" className="terminal-files-breadcrumb">
      {crumbs.map((crumb, index) => {
        const isCurrent = index === crumbs.length - 1;
        return (
          <span className="terminal-files-breadcrumb__item" key={crumb.path}>
            {index > 0 ? (
              <span aria-hidden="true" className="terminal-files-breadcrumb__separator">
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
  accessToken,
  apiBase,
  active,
  projectId,
  onAuthExpired,
  onShowChanges,
}: {
  accessToken: string;
  apiBase: string;
  active: boolean;
  projectId: string | null;
  onAuthExpired: () => void;
  onShowChanges: (change: SelectedTerminalChange) => void;
}) {
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [directory, setDirectory] =
    useState<TerminalPreviewDirectoryResponse | null>(null);
  const [searchItems, setSearchItems] = useState<TerminalPreviewFileSearchItem[]>(
    [],
  );
  const [changes, setChanges] =
    useState<TerminalPreviewGitChangesResponse | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const changeMap = useMemo(() => buildChangeMap(changes), [changes]);
  const changesRequests = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const directoryRequests = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const searchRequests = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );

  useEffect(() => {
    changesRequests.invalidate();
    directoryRequests.invalidate();
    searchRequests.invalidate();
    setPath("");
    setQuery("");
    setDebouncedQuery("");
    setDirectory(null);
    setSearchItems([]);
    setChanges(null);
    setPreviewPath(null);
    setLoading(false);
    setSearchLoading(false);
    setError(null);
    setSearchError(null);
  }, [changesRequests, directoryRequests, projectId, searchRequests]);

  const loadChanges = useCallback(() => {
    if (!projectId) {
      changesRequests.invalidate();
      setChanges(null);
      return;
    }
    const requestId = changesRequests.next();
    void getTerminalProjectPreviewGitChanges(apiBase, accessToken, projectId)
      .then((payload) => {
        if (changesRequests.isCurrent(requestId)) {
          setChanges(payload);
        }
      })
      .catch((nextError: unknown) => {
        if (!changesRequests.isCurrent(requestId)) {
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
        }
      });
  }, [accessToken, apiBase, changesRequests, onAuthExpired, projectId]);

  const loadDirectory = useCallback(() => {
    if (!projectId) {
      directoryRequests.invalidate();
      setDirectory(null);
      setError(null);
      return;
    }
    const requestId = directoryRequests.next();
    setLoading(true);
    setError(null);
    void listTerminalProjectPreviewDirectory(apiBase, accessToken, projectId, {
      path,
      limit: 400,
    })
      .then((payload) => {
        if (directoryRequests.isCurrent(requestId)) {
          setDirectory(payload);
        }
      })
      .catch((nextError: unknown) => {
        if (!directoryRequests.isCurrent(requestId)) {
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        if (nextError instanceof ApiError) {
          setError(previewMessage(nextError.status));
          return;
        }
        setError(nextError instanceof Error ? nextError.message : "Load failed");
      })
      .finally(() => {
        if (directoryRequests.isCurrent(requestId)) {
          setLoading(false);
        }
      });
  }, [
    accessToken,
    apiBase,
    directoryRequests,
    onAuthExpired,
    path,
    projectId,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active) {
      return;
    }
    loadDirectory();
    loadChanges();
  }, [active, loadChanges, loadDirectory]);

  useEffect(() => {
    if (!active || !projectId || !debouncedQuery) {
      searchRequests.invalidate();
      setSearchItems([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    const requestId = searchRequests.next();
    setSearchLoading(true);
    setSearchError(null);
    void searchTerminalProjectPreviewFiles(apiBase, accessToken, projectId, {
      query: debouncedQuery,
      limit: 50,
    })
      .then((payload) => {
        if (searchRequests.isCurrent(requestId)) {
          setSearchItems(payload.items);
        }
      })
      .catch((nextError: unknown) => {
        if (!searchRequests.isCurrent(requestId)) {
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        setSearchError(
          nextError instanceof Error ? nextError.message : "Search failed",
        );
      })
      .finally(() => {
        if (searchRequests.isCurrent(requestId)) {
          setSearchLoading(false);
        }
      });
  }, [
    accessToken,
    active,
    apiBase,
    debouncedQuery,
    onAuthExpired,
    projectId,
    searchRequests,
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
        accessToken={accessToken}
        apiBase={apiBase}
        changeInfo={changeMap.get(previewPath) ?? null}
        filePath={previewPath}
        projectId={projectId}
        onAuthExpired={onAuthExpired}
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
                  {entry.kind === "directory" ? "DIR" : languageBadgeFor(entry.path)}
                </span>
                <span className="terminal-file-row__name">
                  <strong>{basenameOf(entry.path)}</strong>
                  <small>{entry.kind === "directory" ? entry.path : dirnameOf(entry.path)}</small>
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
