import { useCallback, useEffect, useMemo, useState } from "react";
import { IonIcon } from "@ionic/react";
import { checkmarkOutline, copyOutline } from "ionicons/icons";
import type {
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewGitStatus,
} from "@browser-viewer/shared";
import { createTerminalPreviewRequestSequencer } from "@browser-viewer/shared";

import { MobileDiffView } from "./MobileDiffView";
import { useCopyFeedback } from "../hooks/use-copy-feedback";
import { basenameOf, dirnameOf, fileKindOf } from "../lib/terminal-file-format";
import { ApiError } from "../services/http";
import {
  getTerminalProjectPreviewAsset,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
} from "../services/terminal";

type ChangeFilter = "all" | "staged" | "working";
type ChangeViewMode = "diff" | "preview";

export interface SelectedTerminalChange {
  path: string;
  kind: TerminalPreviewChangeKind;
}

interface ChangeRow extends TerminalPreviewChangeFile {
  kind: TerminalPreviewChangeKind;
}

const STATUS_LABELS: Record<TerminalPreviewGitStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  unknown: "?",
};

function changeKey(change: SelectedTerminalChange): string {
  return `${change.kind}:${change.path}`;
}

function flattenChanges(
  changes: TerminalPreviewGitChangesResponse | null,
  filter: ChangeFilter,
): ChangeRow[] {
  if (!changes) {
    return [];
  }
  const staged = changes.staged.map((change) => ({
    ...change,
    kind: "staged" as const,
  }));
  const working = changes.working.map((change) => ({
    ...change,
    kind: "working" as const,
  }));
  if (filter === "staged") {
    return staged;
  }
  if (filter === "working") {
    return working;
  }
  return [...staged, ...working];
}

function previewMessage(status: number): string {
  if (status === 404) {
    return "Project not found";
  }
  if (status === 409) {
    return "Set a project path to use Changes and Files";
  }
  return "Unable to load changes";
}

function ChangeStatusBadge({ status }: { status: TerminalPreviewGitStatus }) {
  return (
    <span className={`terminal-change-badge is-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function ChangeFilterBar({
  filter,
  onFilterChange,
}: {
  filter: ChangeFilter;
  onFilterChange: (filter: ChangeFilter) => void;
}) {
  return (
    <div className="terminal-preview-segment" role="tablist">
      {(["all", "staged", "working"] as const).map((item) => (
        <button
          aria-selected={filter === item}
          className={filter === item ? "is-active" : ""}
          key={item}
          onClick={() => onFilterChange(item)}
          role="tab"
          type="button"
        >
          {item === "all" ? "All" : item === "staged" ? "Staged" : "Working"}
        </button>
      ))}
    </div>
  );
}

export function TerminalChangesTab({
  accessToken,
  apiBase,
  active,
  projectId,
  requestedChange,
  onAuthExpired,
  onChangesCount,
}: {
  accessToken: string;
  apiBase: string;
  active: boolean;
  projectId: string | null;
  requestedChange: SelectedTerminalChange | null;
  onAuthExpired: () => void;
  onChangesCount: (count: number) => void;
}) {
  const [changes, setChanges] =
    useState<TerminalPreviewGitChangesResponse | null>(null);
  const [filter, setFilter] = useState<ChangeFilter>("all");
  const [selectedChange, setSelectedChange] =
    useState<SelectedTerminalChange | null>(null);
  const [viewMode, setViewMode] = useState<ChangeViewMode>("diff");
  const [diff, setDiff] = useState<TerminalPreviewFileDiffResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [viewedKeys, setViewedKeys] = useState<Set<string>>(() => new Set());
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const { copied: pathCopied, copyText: copyPath } = useCopyFeedback();
  const changesRequests = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const diffRequests = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );
  const assetRequests = useMemo(
    () => createTerminalPreviewRequestSequencer(),
    [],
  );

  useEffect(() => {
    changesRequests.invalidate();
    diffRequests.invalidate();
    assetRequests.invalidate();
    setChanges(null);
    setSelectedChange(null);
    setDiff(null);
    setAssetUrl(null);
    setError(null);
    setDiffError(null);
    setLoading(false);
    setDiffLoading(false);
    setViewedKeys(new Set());
    onChangesCount(0);
  }, [assetRequests, changesRequests, diffRequests, onChangesCount, projectId]);

  const loadChanges = useCallback(() => {
    if (!projectId) {
      changesRequests.invalidate();
      setChanges(null);
      setError(null);
      onChangesCount(0);
      return;
    }

    const requestId = changesRequests.next();
    setLoading(true);
    setError(null);
    void getTerminalProjectPreviewGitChanges(apiBase, accessToken, projectId)
      .then((payload) => {
        if (!changesRequests.isCurrent(requestId)) {
          return;
        }
        setChanges(payload);
        onChangesCount(payload.staged.length + payload.working.length);
      })
      .catch((nextError: unknown) => {
        if (!changesRequests.isCurrent(requestId)) {
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
        if (changesRequests.isCurrent(requestId)) {
          setLoading(false);
        }
      });
  }, [
    accessToken,
    apiBase,
    changesRequests,
    onAuthExpired,
    onChangesCount,
    projectId,
  ]);

  useEffect(() => {
    if (active) {
      loadChanges();
    }
  }, [active, loadChanges]);

  useEffect(() => {
    if (requestedChange) {
      setSelectedChange(requestedChange);
      setViewMode("diff");
    }
  }, [requestedChange]);

  useEffect(() => {
    if (!projectId || !selectedChange) {
      diffRequests.invalidate();
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }

    const requestId = diffRequests.next();
    const requested = selectedChange;
    setDiffLoading(true);
    setDiffError(null);
    void getTerminalProjectPreviewFileDiff(apiBase, accessToken, projectId, {
      path: requested.path,
      kind: requested.kind,
    })
      .then((payload) => {
        if (!diffRequests.isCurrent(requestId)) {
          return;
        }
        setDiff(payload);
        setViewedKeys((current) => {
          const next = new Set(current);
          next.add(changeKey(requested));
          return next;
        });
      })
      .catch((nextError: unknown) => {
        if (!diffRequests.isCurrent(requestId)) {
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        if (nextError instanceof ApiError) {
          setDiffError(
            nextError.status === 404 ? "File not found" : "Unable to load diff",
          );
          return;
        }
        setDiffError(
          nextError instanceof Error ? nextError.message : "Load failed",
        );
      })
      .finally(() => {
        if (diffRequests.isCurrent(requestId)) {
          setDiffLoading(false);
        }
      });
  }, [
    accessToken,
    apiBase,
    diffRequests,
    onAuthExpired,
    projectId,
    selectedChange,
  ]);

  const rows = useMemo(
    () => flattenChanges(changes, filter),
    [changes, filter],
  );

  const selectedFileKind = selectedChange
    ? fileKindOf(selectedChange.path, null)
    : "text";
  const previewAvailable =
    selectedFileKind === "markdown" ||
    selectedFileKind === "svg" ||
    selectedFileKind === "image";

  useEffect(() => {
    if (!previewAvailable && viewMode === "preview") {
      setViewMode("diff");
    }
  }, [previewAvailable, viewMode]);

  useEffect(() => {
    if (!projectId || !selectedChange || viewMode !== "preview") {
      assetRequests.invalidate();
      setAssetUrl(null);
      return;
    }
    if (fileKindOf(selectedChange.path, null) !== "image") {
      assetRequests.invalidate();
      setAssetUrl(null);
      return;
    }

    const requestId = assetRequests.next();
    let nextUrl: string | null = null;
    setAssetUrl(null);
    void getTerminalProjectPreviewAsset(
      apiBase,
      accessToken,
      projectId,
      selectedChange.path,
    )
      .then((blob) => {
        if (!assetRequests.isCurrent(requestId)) {
          return;
        }
        nextUrl = URL.createObjectURL(blob);
        setAssetUrl(nextUrl);
      })
      .catch(() => {
        if (assetRequests.isCurrent(requestId)) {
          setAssetUrl(null);
        }
      });

    return () => {
      assetRequests.invalidate();
      if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [accessToken, apiBase, assetRequests, projectId, selectedChange, viewMode]);

  if (!projectId) {
    return (
      <section className="terminal-preview-pane">
        <p className="terminal-preview-empty">
          Set a project path to use Changes and Files
        </p>
      </section>
    );
  }

  if (selectedChange) {
    return (
      <section className="terminal-preview-pane">
        <header className="terminal-preview-subheader">
          <button
            className="terminal-preview-link"
            onClick={() => setSelectedChange(null)}
            type="button"
          >
            Back
          </button>
          <div className="terminal-preview-title">
            <h2>{basenameOf(selectedChange.path)}</h2>
            <p>{selectedChange.path}</p>
          </div>
          {diff ? <ChangeStatusBadge status={diff.status} /> : null}
        </header>
        <div className="terminal-preview-toolbar">
          {previewAvailable ? (
            <div className="terminal-preview-segment" role="tablist">
              <button
                aria-selected={viewMode === "diff"}
                className={viewMode === "diff" ? "is-active" : ""}
                onClick={() => setViewMode("diff")}
                role="tab"
                type="button"
              >
                Diff
              </button>
              <button
                aria-selected={viewMode === "preview"}
                className={viewMode === "preview" ? "is-active" : ""}
                onClick={() => setViewMode("preview")}
                role="tab"
                type="button"
              >
                Preview
              </button>
            </div>
          ) : (
            <span className="terminal-preview-mode-label">Diff</span>
          )}
          <button
            aria-label={pathCopied ? "Path copied" : "Copy path"}
            className={`terminal-preview-icon-button ${
              pathCopied ? "is-copied" : ""
            }`}
            onClick={() => void copyPath(selectedChange.path)}
            title={pathCopied ? "Path copied" : "Copy path"}
            type="button"
          >
            <IonIcon
              aria-hidden="true"
              icon={pathCopied ? checkmarkOutline : copyOutline}
            />
          </button>
        </div>
        {diffLoading ? (
          <p className="terminal-preview-empty">Loading diff...</p>
        ) : diffError ? (
          <div className="terminal-preview-state">
            <p>{diffError}</p>
            <button onClick={() => setSelectedChange({ ...selectedChange })} type="button">
              Retry
            </button>
          </div>
        ) : viewMode === "preview" ? (
          <div className="terminal-preview-file">
            {selectedFileKind === "image" && assetUrl ? (
              <img alt={basenameOf(selectedChange.path)} src={assetUrl} />
            ) : diff && selectedFileKind === "markdown" ? (
              <pre>{diff.newContent}</pre>
            ) : diff && selectedFileKind === "svg" ? (
              <pre>{diff.newContent}</pre>
            ) : (
              <p className="terminal-preview-empty">Preview unavailable.</p>
            )}
          </div>
        ) : diff ? (
          <MobileDiffView diff={diff} />
        ) : null}
      </section>
    );
  }

  return (
    <section className="terminal-preview-pane">
      <header className="terminal-preview-header">
        <div>
          <h2>Changes</h2>
          <p>
            {(changes?.staged.length ?? 0) + (changes?.working.length ?? 0)}{" "}
            changed files
          </p>
        </div>
        <button
          className="terminal-preview-action"
          disabled={loading}
          onClick={loadChanges}
          type="button"
        >
          Refresh
        </button>
      </header>
      <ChangeFilterBar filter={filter} onFilterChange={setFilter} />
      {loading ? (
        <p className="terminal-preview-empty">Loading changes...</p>
      ) : error ? (
        <div className="terminal-preview-state">
          <p>{error}</p>
          <button onClick={loadChanges} type="button">
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="terminal-preview-empty">No changes.</p>
      ) : (
        <div className="terminal-change-list">
          {rows.map((change) => (
            <button
              className={`terminal-change-row ${
                viewedKeys.has(changeKey(change)) ? "is-viewed" : ""
              }`}
              key={changeKey(change)}
              onClick={() => {
                setSelectedChange({ path: change.path, kind: change.kind });
                setViewMode("diff");
              }}
              type="button"
            >
              <ChangeStatusBadge status={change.status} />
              <span className="terminal-change-row__path">
                <small>{dirnameOf(change.path)}</small>
                <strong>{basenameOf(change.path)}</strong>
              </span>
              <em>{change.kind}</em>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
