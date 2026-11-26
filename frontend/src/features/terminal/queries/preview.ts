import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TerminalPreviewBranchChangesResponse,
  TerminalPreviewBranchCommitsResponse,
  TerminalPreviewChangeKind,
  TerminalPreviewChangeScope,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewGitChangesResponse,
} from "@runweave/shared/terminal/preview";
import { useDebouncedValue } from "../../query/use-debounced-value";
import { isSupportedTerminalImagePreviewPath, isSupportedTerminalVideoPreviewPath } from "../preview/file-types";
import {
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitBranchChanges,
  getTerminalProjectPreviewGitBranchCommits,
  getTerminalProjectPreviewGitChanges,
  searchTerminalProjectPreviewFiles,
} from "../../../services/terminal/preview";
import { terminalQueryKeys } from "./keys";
import { useTerminalRuntime } from "./provider";

const PREVIEW_SEARCH_DEBOUNCE_MS = 250;
// File bodies and diffs are reloadable; do not retain every visited file for
// the connection's default 30 minutes. Active queries remain available.
const PREVIEW_GC_TIME_MS = 60_000;

export function useTerminalPreviewQueries(input: {
  projectId: string | null;
  hasProjectPath: boolean;
  mode: "file" | "changes" | "explorer" | "branch-updates" | null;
  changesScope?: TerminalPreviewChangeScope;
  selectedCommitOid?: string;
  query: string;
  selectedFilePath?: string;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
}) {
  const queryClient = useQueryClient();
  const { apiBase, scope, token } = useTerminalRuntime();
  const debouncedSearch = useDebouncedValue(
    input.query,
    PREVIEW_SEARCH_DEBOUNCE_MS,
  );
  const projectId = input.projectId ?? "";
  const changesScope = input.changesScope ?? "working";
  const selectedFilePath = input.selectedFilePath ?? "";
  const selectedChangePath = input.selectedChangePath ?? "";
  const selectedChangeKind = input.selectedChangeKind ?? "working";
  const searchEnabled =
    Boolean(projectId && input.hasProjectPath) &&
    input.mode === "file" &&
    !input.query.trim().startsWith("/") &&
    debouncedSearch === input.query;
  const searchPending =
    Boolean(projectId && input.hasProjectPath) &&
    input.mode === "file" &&
    !input.query.trim().startsWith("/") &&
    debouncedSearch !== input.query;
  const fileEnabled =
    Boolean(projectId && selectedFilePath) &&
    (input.mode === "file" || input.mode === "explorer") &&
    !isSupportedTerminalImagePreviewPath(selectedFilePath) &&
    !isSupportedTerminalVideoPreviewPath(selectedFilePath);
  const changesEnabled =
    Boolean(projectId && input.hasProjectPath) &&
    (input.mode === null || input.mode === "changes");
  const branchChangesEnabled =
    changesEnabled &&
    input.mode === "changes" &&
    (changesScope === "branch" || changesScope === "working");
  const branchCommitsEnabled =
    changesEnabled && input.mode === "changes" && changesScope === "commits";

  const search = useQuery({
    gcTime: PREVIEW_GC_TIME_MS,
    queryKey: terminalQueryKeys.previewFileSearch({
      scope,
      projectId,
      query: debouncedSearch,
    }),
    queryFn: () =>
      searchTerminalProjectPreviewFiles(apiBase, token, projectId, {
        query: debouncedSearch,
        limit: 50,
      }),
    enabled: searchEnabled,
  });
  const file = useQuery({
    gcTime: PREVIEW_GC_TIME_MS,
    queryKey: terminalQueryKeys.previewFile({
      scope,
      projectId,
      path: selectedFilePath,
    }),
    queryFn: () =>
      getTerminalProjectPreviewFile(
        apiBase,
        token,
        projectId,
        selectedFilePath,
      ),
    enabled: fileEnabled,
  });
  const changes = useQuery({
    queryKey: terminalQueryKeys.previewChanges(scope, projectId),
    queryFn: () =>
      getTerminalProjectPreviewGitChanges(apiBase, token, projectId),
    enabled: changesEnabled,
  });
  const branchChanges = useQuery({
    queryKey: terminalQueryKeys.previewBranchChanges(scope, projectId),
    queryFn: () =>
      getTerminalProjectPreviewGitBranchChanges(apiBase, token, projectId),
    enabled: branchChangesEnabled,
  });
  const branchCommits = useQuery({
    queryKey: terminalQueryKeys.previewBranchCommits({
      scope,
      projectId,
      commitOid: input.selectedCommitOid,
    }),
    queryFn: () =>
      getTerminalProjectPreviewGitBranchCommits(apiBase, token, projectId, {
        commitOid: input.selectedCommitOid,
      }),
    enabled: branchCommitsEnabled,
  });

  const activeBaseOid =
    selectedChangeKind === "branch"
      ? branchChanges.data?.state === "ready"
        ? branchChanges.data.mergeBaseOid
        : undefined
      : undefined;
  const activeCommitOid =
    selectedChangeKind === "commit"
      ? branchCommits.data?.state === "ready"
        ? (branchCommits.data.selectedCommitOid ?? undefined)
        : undefined
      : undefined;
  const diffEnabled =
    changesEnabled &&
    input.mode === "changes" &&
    Boolean(input.selectedChangePath && input.selectedChangeKind) &&
    (selectedChangeKind === "branch"
      ? Boolean(activeBaseOid)
      : selectedChangeKind === "commit"
        ? Boolean(activeCommitOid)
        : true);

  const diff = useQuery({
    gcTime: PREVIEW_GC_TIME_MS,
    queryKey: terminalQueryKeys.previewDiff({
      scope,
      projectId,
      path: selectedChangePath,
      kind: selectedChangeKind,
      baseOid: activeBaseOid,
      commitOid: activeCommitOid,
    }),
    queryFn: () =>
      getTerminalProjectPreviewFileDiff(apiBase, token, projectId, {
        path: selectedChangePath,
        kind: selectedChangeKind,
        baseOid: activeBaseOid,
        commitOid: activeCommitOid,
      }),
    enabled: diffEnabled,
    retry: false,
  });

  const setFile = (
    path: string,
    value: TerminalPreviewFileResponse | undefined,
  ) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewFile({ scope, projectId, path }),
      value,
    );
  };
  const setDiff = (
    path: string,
    kind: TerminalPreviewChangeKind,
    value: TerminalPreviewFileDiffResponse | undefined,
    options?: { baseOid?: string; commitOid?: string },
  ) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewDiff({
        scope,
        projectId,
        path,
        kind,
        baseOid: options?.baseOid,
        commitOid: options?.commitOid,
      }),
      value,
    );
  };
  const setChanges = (value: TerminalPreviewGitChangesResponse | undefined) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewChanges(scope, projectId),
      value,
    );
  };
  const setBranchChanges = (
    value: TerminalPreviewBranchChangesResponse | undefined,
  ) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewBranchChanges(scope, projectId),
      value,
    );
  };
  const setBranchCommits = (
    value: TerminalPreviewBranchCommitsResponse | undefined,
    commitOid?: string,
  ) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewBranchCommits({
        scope,
        projectId,
        commitOid,
      }),
      value,
    );
  };

  return {
    search,
    searchPending,
    file,
    changes,
    branchChanges,
    branchCommits,
    activeBaseOid,
    activeCommitOid,
    diff,
    queryClient,
    scope,
    setFile,
    setDiff,
    setChanges,
    setBranchChanges,
    setBranchCommits,
  };
}
