import { useEffect, useRef } from "react";
import { useMemoizedFn } from "ahooks";
import type { QueryClient } from "@tanstack/react-query";
import {
  type TerminalPreviewChangeKind,
} from "@runweave/shared/terminal/preview";
import { useTerminalPreviewStore } from "../../../../features/terminal/preview/store";
import { terminalQueryKeys } from "../../../../features/terminal/queries/keys";
import { HttpError } from "../../../../services/http";
import {
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
} from "../../../../services/terminal/preview";
import { resolveSelectedPreviewChange } from "./use-keyboard";

export function useTerminalPreviewChangeRefresh({
  apiBase, token, projectId, projectPath, scope, queryClient, onError,
}: {
  apiBase: string;
  token: string;
  projectId: string | null;
  projectPath?: string | null;
  scope: string;
  queryClient: QueryClient;
  onError: (error: unknown) => string;
}) {
  const generation = useRef(0);
  useEffect(() => {
    // Selection changes (including away and back) invalidate in-flight work.
    const unsubscribe = useTerminalPreviewStore.subscribe((state, previous) => {
      const next = projectId ? state.projects[projectId] : undefined;
      const old = projectId ? previous.projects[projectId] : undefined;
      if (state.connectionScope !== previous.connectionScope
        || next?.mode !== old?.mode
        || next?.selectedChangePath !== old?.selectedChangePath
        || next?.selectedChangeKind !== old?.selectedChangeKind) generation.current += 1;
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, [projectId, projectPath, scope]);

  const isCurrentProject = useMemoizedFn((id: string, path: string | null | undefined, connection: string) =>
    id === projectId && path === projectPath && connection === scope);

  const beginOperation = () => {
    const state = useTerminalPreviewStore.getState();
    const selection = projectId ? state.projects[projectId] : undefined;
    const operation = ++generation.current;
    const current = () => {
      const latest = useTerminalPreviewStore.getState();
      const selected = projectId ? latest.projects[projectId] : undefined;
      return operation === generation.current
        && Boolean(projectId && isCurrentProject(projectId, projectPath, scope))
        && latest.connectionScope === state.connectionScope
        && selected?.mode === selection?.mode
        && selected?.selectedChangePath === selection?.selectedChangePath
        && selected?.selectedChangeKind === selection?.selectedChangeKind;
    };
    return { current, selection };
  };
  const fetchChanges = () => queryClient.fetchQuery({
    queryKey: terminalQueryKeys.previewChanges(scope, projectId!),
    queryFn: () => getTerminalProjectPreviewGitChanges(apiBase, token, projectId!),
    staleTime: 0,
    retry: false,
  });
  const fetchDiff = (path: string, kind: TerminalPreviewChangeKind) => queryClient.fetchQuery({
    queryKey: terminalQueryKeys.previewDiff({ scope, projectId: projectId!, path, kind }),
    queryFn: () => getTerminalProjectPreviewFileDiff(apiBase, token, projectId!, { path, kind }),
    staleTime: 0,
    retry: false,
  });

  const loadChanges = useMemoizedFn(async (options?: { preserveMode?: boolean }): Promise<void> => {
    if (!projectId) return;
    const { current, selection } = beginOperation();
    try {
      const changes = await fetchChanges();
      if (!current() || options?.preserveMode) return;
      const selected = resolveSelectedPreviewChange({ changes, ...selection });
      const store = useTerminalPreviewStore.getState();
      if (!selected) {
        store.setProjectPreviewMode(projectId, "changes");
        store.clearSelectedChange(projectId);
      } else if (selected.path !== selection?.selectedChangePath || selected.kind !== selection?.selectedChangeKind) {
        store.selectChange(projectId, selected.path, selected.kind);
      }
    } catch (error) {
      // The query's visible error state remains authoritative.
      if (current()) onError(error);
    }
  });

  const loadDiff = useMemoizedFn(async (path: string, kind: TerminalPreviewChangeKind): Promise<void> => {
    if (!projectId) return;
    const { current, selection } = beginOperation();
    try {
      await fetchDiff(path, kind);
    } catch (error) {
      if (!current()) return;
      const staleDiff = error instanceof HttpError && error.status === 409
        && (error.code === "terminal_preview_stale_diff" || (error.code === undefined && [
          "Change no longer exists; refresh the list",
          "Change moved; refresh the list",
          "Original version moved; refresh the list",
        ].includes(error.message)));
      if (!staleDiff
        || selection?.selectedChangePath !== path || selection?.selectedChangeKind !== kind) {
        onError(error);
        return;
      }
      let recoveryCurrent = current;
      try {
        const changes = await fetchChanges();
        if (!current()) return;
        // Keep the same file when it moves between working and staged.
        // Prefer the original kind when the path still exists in both lists.
        const selected = resolveSelectedPreviewChange({
          changes,
          selectedChangePath: path,
          selectedChangeKind: changes[kind].some((file) => file.path === path)
            ? kind
            : kind === "staged" ? "working" : "staged",
        });
        const store = useTerminalPreviewStore.getState();
        if (!selected) {
          store.clearSelectedChange(projectId);
          return;
        }
        // Start before selecting: React Query shares this in-flight request with
        // the newly selected observer. No second automatic recovery is allowed.
        const retry = fetchDiff(selected.path, selected.kind);
        if (selected.path !== path || selected.kind !== kind) {
          store.selectChange(projectId, selected.path, selected.kind);
          recoveryCurrent = beginOperation().current;
        }
        await retry;
      } catch (recoveryError) {
        // Both refresh and retry failures are rendered by their query observers.
        if (recoveryCurrent()) onError(recoveryError);
      }
    }
  });

  return { loadChanges, loadDiff };
}
