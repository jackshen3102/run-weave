import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalPreviewGitChangesResponse,
} from "@runweave/shared/terminal/preview";
import { useDebouncedValue } from "../../query/use-debounced-value";
import { isSupportedTerminalImagePreviewPath } from "../preview-file-types";
import {
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  searchTerminalProjectPreviewFiles,
} from "../../../services/terminal-preview";
import { terminalQueryKeys } from "./terminal-query-keys";
import { useTerminalRuntime } from "./terminal-runtime-provider";

const PREVIEW_SEARCH_DEBOUNCE_MS = 250;

export function useTerminalPreviewQueries(input: {
  projectId: string | null;
  hasProjectPath: boolean;
  mode: "file" | "changes" | "explorer" | null;
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
  const selectedFilePath = input.selectedFilePath ?? "";
  const selectedChangePath = input.selectedChangePath ?? "";
  const selectedChangeKind = input.selectedChangeKind ?? "working";
  const searchEnabled =
    Boolean(projectId) &&
    input.mode === "file" &&
    !input.query.trim().startsWith("/") &&
    debouncedSearch === input.query;
  const searchPending =
    Boolean(projectId) &&
    input.mode === "file" &&
    !input.query.trim().startsWith("/") &&
    debouncedSearch !== input.query;
  const fileEnabled =
    Boolean(projectId && selectedFilePath) &&
    (input.mode === "file" || input.mode === "explorer") &&
    !isSupportedTerminalImagePreviewPath(selectedFilePath);
  const changesEnabled =
    Boolean(projectId && input.hasProjectPath) && input.mode === "changes";
  const diffEnabled =
    changesEnabled &&
    Boolean(input.selectedChangePath && input.selectedChangeKind);

  const search = useQuery({
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
  const diff = useQuery({
    queryKey: terminalQueryKeys.previewDiff({
      scope,
      projectId,
      path: selectedChangePath,
      kind: selectedChangeKind,
    }),
    queryFn: () =>
      getTerminalProjectPreviewFileDiff(apiBase, token, projectId, {
        path: selectedChangePath,
        kind: selectedChangeKind,
      }),
    enabled: diffEnabled,
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
  ) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewDiff({ scope, projectId, path, kind }),
      value,
    );
  };
  const setChanges = (value: TerminalPreviewGitChangesResponse | undefined) => {
    queryClient.setQueryData(
      terminalQueryKeys.previewChanges(scope, projectId),
      value,
    );
  };

  return {
    search,
    searchPending,
    file,
    changes,
    diff,
    queryClient,
    scope,
    setFile,
    setDiff,
    setChanges,
  };
}
