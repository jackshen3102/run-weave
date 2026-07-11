import { useMemoizedFn } from "ahooks";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { IonIcon } from "@ionic/react";
import { checkmarkOutline, copyOutline } from "ionicons/icons";
import type {
  TerminalPreviewChangeFile,
  TerminalPreviewChangeKind,
  TerminalPreviewGitChangesResponse,
  TerminalPreviewGitStatus,
} from "@runweave/shared/terminal/preview";

import { MobileDiffView } from "./MobileDiffView";
import type { SelectedTerminalChange } from "../features/terminal/types";
import { useCopyFeedback } from "../hooks/use-copy-feedback";
import { basenameOf, dirnameOf, fileKindOf } from "../lib/terminal-file-format";
import { ApiError } from "../services/http";
import {
  getTerminalProjectPreviewAsset,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
} from "../services/terminal";
import { TerminalZoomableImage } from "./TerminalZoomableImage";
import { appQueryKeys } from "../features/query/app-query-provider";
import { useAppTerminalRuntime } from "../features/terminal/app-terminal-runtime";

type ChangeFilter = "all" | "staged" | "working";
type ChangeViewMode = "diff" | "preview";

export type { SelectedTerminalChange } from "../features/terminal/types";

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
  active,
  requestedChange,
  onChangesCount,
}: {
  active: boolean;
  requestedChange: SelectedTerminalChange | null;
  onChangesCount: (count: number) => void;
}) {
  const { accessToken, apiBase, onAuthExpired, projectId, scope } =
    useAppTerminalRuntime();
  const [filter, setFilter] = useState<ChangeFilter>("all");
  const [selectedChange, setSelectedChange] =
    useState<SelectedTerminalChange | null>(null);
  const [viewMode, setViewMode] = useState<ChangeViewMode>("diff");
  const [viewedKeys, setViewedKeys] = useState<Set<string>>(() => new Set());
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const { copied: pathCopied, copyText: copyPath } = useCopyFeedback();
  const changesQuery = useQuery({
    queryKey: projectId
      ? appQueryKeys.terminalChanges(scope, projectId)
      : [...appQueryKeys.all(scope), "terminal-preview", "no-project"],
    queryFn: () =>
      getTerminalProjectPreviewGitChanges(apiBase, accessToken, projectId!),
    enabled: active && Boolean(projectId),
  });
  const diffQuery = useQuery({
    queryKey:
      projectId && selectedChange
        ? appQueryKeys.terminalDiff(
            scope,
            projectId,
            selectedChange.path,
            selectedChange.kind,
          )
        : [...appQueryKeys.all(scope), "terminal-preview", "no-diff"],
    queryFn: () =>
      getTerminalProjectPreviewFileDiff(apiBase, accessToken, projectId!, {
        path: selectedChange!.path,
        kind: selectedChange!.kind,
      }),
    enabled: active && Boolean(projectId && selectedChange),
  });
  const selectedFileKind = selectedChange
    ? fileKindOf(selectedChange.path, null)
    : "text";
  const previewAvailable =
    selectedFileKind === "markdown" ||
    selectedFileKind === "svg" ||
    selectedFileKind === "image";
  const assetQuery = useQuery({
    queryKey:
      projectId && selectedChange
        ? appQueryKeys.terminalAsset(scope, projectId, selectedChange.path)
        : [...appQueryKeys.all(scope), "terminal-preview", "no-asset"],
    queryFn: () =>
      getTerminalProjectPreviewAsset(
        apiBase,
        accessToken,
        projectId!,
        selectedChange!.path,
      ),
    enabled:
      active &&
      Boolean(projectId && selectedChange) &&
      viewMode === "preview" &&
      selectedFileKind === "image",
  });
  const changes = changesQuery.data ?? null;
  const diff = diffQuery.data ?? null;
  const loading = changesQuery.isFetching;
  const diffLoading = diffQuery.isFetching;
  const error = changesQuery.error
    ? changesQuery.error instanceof ApiError
      ? previewMessage(changesQuery.error.status)
      : changesQuery.error instanceof Error
        ? changesQuery.error.message
        : "Load failed"
    : null;
  const diffError = diffQuery.error
    ? diffQuery.error instanceof ApiError && diffQuery.error.status === 404
      ? "File not found"
      : "Unable to load diff"
    : null;

  useEffect(() => {
    setSelectedChange(null);
    setAssetUrl(null);
    setViewedKeys(new Set());
    onChangesCount(0);
  }, [onChangesCount, projectId]);

  useEffect(() => {
    if (requestedChange) {
      setSelectedChange(requestedChange);
      setViewMode("diff");
    }
  }, [requestedChange]);

  useEffect(() => {
    if (changes) {
      onChangesCount(changes.staged.length + changes.working.length);
    }
  }, [changes, onChangesCount]);

  useEffect(() => {
    if (
      (changesQuery.error instanceof ApiError &&
        changesQuery.error.status === 401) ||
      (diffQuery.error instanceof ApiError && diffQuery.error.status === 401)
    ) {
      onAuthExpired();
    }
  }, [changesQuery.error, diffQuery.error, onAuthExpired]);

  useEffect(() => {
    if (!diff || !selectedChange) {
      return;
    }
    setViewedKeys((current) => {
      const key = changeKey(selectedChange);
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, [diff, selectedChange]);

  const loadChanges = useMemoizedFn(() => {
    if (!projectId) {
      onChangesCount(0);
      return;
    }
    void changesQuery.refetch();
  });

  const rows = useMemo(
    () => flattenChanges(changes, filter),
    [changes, filter],
  );

  useEffect(() => {
    if (!previewAvailable && viewMode === "preview") {
      setViewMode("diff");
    }
  }, [previewAvailable, viewMode]);

  useEffect(() => {
    if (
      viewMode !== "preview" ||
      selectedFileKind !== "image" ||
      !assetQuery.data
    ) {
      setAssetUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(assetQuery.data);
    setAssetUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [assetQuery.data, selectedFileKind, viewMode]);

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
            <button onClick={() => void diffQuery.refetch()} type="button">
              Retry
            </button>
          </div>
        ) : viewMode === "preview" ? (
          <div className="terminal-preview-file">
            {selectedFileKind === "image" && assetUrl ? (
              <TerminalZoomableImage
                alt={basenameOf(selectedChange.path)}
                src={assetUrl}
                title={selectedChange.path}
              />
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
