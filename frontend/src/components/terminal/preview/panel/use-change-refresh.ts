import { useEffect, useRef } from "react";
import { useMemoizedFn } from "ahooks";
import type { QueryClient } from "@tanstack/react-query";
import {
  type TerminalPreviewChangeKind,
  type TerminalPreviewChangeScope,
} from "@runweave/shared/terminal/preview";
import { useTerminalPreviewStore } from "../../../../features/terminal/preview/store";
import { terminalQueryKeys } from "../../../../features/terminal/queries/keys";
import { HttpError } from "../../../../services/http";
import {
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitBranchChanges,
  getTerminalProjectPreviewGitBranchCommits,
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
        || next?.changesScope !== old?.changesScope
        || next?.selectedCommitOid !== old?.selectedCommitOid
        || next?.selectedChangePath !== old?.selectedChangePath
        || next?.selectedChangeKind !== old?.selectedChangeKind
        || next?.selectedBranchChangePath !== old?.selectedBranchChangePath
        || next?.selectedCommitChangePath !== old?.selectedCommitChangePath) generation.current += 1;
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
        && selected?.changesScope === selection?.changesScope
        && selected?.selectedCommitOid === selection?.selectedCommitOid
        && selected?.selectedChangePath === selection?.selectedChangePath
        && selected?.selectedChangeKind === selection?.selectedChangeKind
        && selected?.selectedBranchChangePath === selection?.selectedBranchChangePath
        && selected?.selectedCommitChangePath === selection?.selectedCommitChangePath;
    };
    return { current, selection };
  };
  const fetchChanges = () => queryClient.fetchQuery({
    queryKey: terminalQueryKeys.previewChanges(scope, projectId!),
    queryFn: () => getTerminalProjectPreviewGitChanges(apiBase, token, projectId!),
    staleTime: 0,
    retry: false,
  });
  const fetchBranchChanges = () => queryClient.fetchQuery({
    queryKey: terminalQueryKeys.previewBranchChanges(scope, projectId!),
    queryFn: () => getTerminalProjectPreviewGitBranchChanges(apiBase, token, projectId!),
    staleTime: 0,
    retry: false,
  });
  const fetchBranchCommits = (commitOid?: string) => queryClient.fetchQuery({
    queryKey: terminalQueryKeys.previewBranchCommits({ scope, projectId: projectId!, commitOid }),
    queryFn: () => getTerminalProjectPreviewGitBranchCommits(apiBase, token, projectId!, { commitOid }),
    staleTime: 0,
    retry: false,
  });
  const fetchDiff = (
    path: string,
    kind: TerminalPreviewChangeKind,
    options?: { baseOid?: string; commitOid?: string },
  ) => queryClient.fetchQuery({
    queryKey: terminalQueryKeys.previewDiff({
      scope,
      projectId: projectId!,
      path,
      kind,
      baseOid: options?.baseOid,
      commitOid: options?.commitOid,
    }),
    queryFn: () => getTerminalProjectPreviewFileDiff(apiBase, token, projectId!, {
      path,
      kind,
      baseOid: options?.baseOid,
      commitOid: options?.commitOid,
    }),
    staleTime: 0,
    retry: false,
  });

  const loadChanges = useMemoizedFn(async (options?: {
    preserveMode?: boolean;
    changesScope?: TerminalPreviewChangeScope;
  }): Promise<void> => {
    if (!projectId) return;
    const { current, selection } = beginOperation();
    const targetScope = options?.changesScope ?? selection?.changesScope ?? "working";
    try {
      if (targetScope === "branch") {
        const [branchChanges] = await Promise.all([
          fetchBranchChanges(),
          fetchChanges().catch(() => null),
        ]);
        if (!current() || options?.preserveMode) return;
        const store = useTerminalPreviewStore.getState();
        if (branchChanges.state !== "ready" || branchChanges.files.length === 0) {
          store.clearSelectedChange(projectId, "branch");
          return;
        }
        const existing = selection?.selectedBranchChangePath;
        const nextPath =
          existing && branchChanges.files.some((f) => f.path === existing)
            ? existing
            : branchChanges.files[0]!.path;
        if (nextPath !== existing) {
          store.selectChange(projectId, nextPath, "branch");
        }
        return;
      }

      if (targetScope === "commits") {
        let commitsData;
        try {
          commitsData = await fetchBranchCommits(selection?.selectedCommitOid);
        } catch (err) {
          if (
            err instanceof HttpError &&
            err.status === 409 &&
            selection?.selectedCommitOid
          ) {
            commitsData = await fetchBranchCommits(undefined);
            if (current()) {
              useTerminalPreviewStore
                .getState()
                .setSelectedCommitOid(
                  projectId,
                  commitsData.selectedCommitOid ?? undefined,
                );
            }
          } else {
            throw err;
          }
        }
        if (!current() || options?.preserveMode) return;
        const store = useTerminalPreviewStore.getState();
        if (commitsData.state !== "ready" || commitsData.files.length === 0) {
          store.clearSelectedChange(projectId, "commits");
          return;
        }
        const existing = selection?.selectedCommitChangePath;
        const nextPath =
          existing && commitsData.files.some((f) => f.path === existing)
            ? existing
            : commitsData.files[0]!.path;
        if (nextPath !== existing) {
          store.selectChange(projectId, nextPath, "commit");
        }
        return;
      }

      const [changes] = await Promise.all([
        fetchChanges(),
        fetchBranchChanges().catch(() => null),
      ]);
      if (!current() || options?.preserveMode) return;
      const selected = resolveSelectedPreviewChange({ changes, ...selection });
      const store = useTerminalPreviewStore.getState();
      if (!selected) {
        store.setProjectPreviewMode(projectId, "changes");
        store.clearSelectedChange(projectId, "working");
      } else if (selected.path !== selection?.selectedChangePath || selected.kind !== selection?.selectedChangeKind) {
        store.selectChange(projectId, selected.path, selected.kind);
      }
    } catch (error) {
      // The query's visible error state remains authoritative.
      if (current()) onError(error);
    }
  });

  const recoverStaleDiff = useMemoizedFn(async (
    path: string,
    kind: TerminalPreviewChangeKind,
  ): Promise<void> => {
    if (!projectId) return;
    const { current } = beginOperation();
    let recoveryCurrent = current;
    try {
      if (kind === "branch") {
        const branchChanges = await fetchBranchChanges();
        if (!current()) return;
        const store = useTerminalPreviewStore.getState();
        if (branchChanges.state !== "ready" || !branchChanges.mergeBaseOid || branchChanges.files.length === 0) {
          store.clearSelectedChange(projectId, "branch");
          return;
        }
        const nextPath = branchChanges.files.some((f) => f.path === path)
          ? path
          : branchChanges.files[0]!.path;
        const retry = fetchDiff(nextPath, "branch", {
          baseOid: branchChanges.mergeBaseOid,
        });
        if (nextPath !== path) {
          store.selectChange(projectId, nextPath, "branch");
          recoveryCurrent = beginOperation().current;
        }
        await retry;
        return;
      }

      if (kind === "commit") {
        const commitsData = await fetchBranchCommits(undefined);
        if (!current()) return;
        const store = useTerminalPreviewStore.getState();
        store.setSelectedCommitOid(
          projectId,
          commitsData.selectedCommitOid ?? undefined,
        );
        if (
          commitsData.state !== "ready" ||
          !commitsData.selectedCommitOid ||
          commitsData.files.length === 0
        ) {
          store.clearSelectedChange(projectId, "commits");
          return;
        }
        const nextPath = commitsData.files.some((f) => f.path === path)
          ? path
          : commitsData.files[0]!.path;
        const retry = fetchDiff(nextPath, "commit", {
          commitOid: commitsData.selectedCommitOid,
        });
        store.selectChange(projectId, nextPath, "commit");
        recoveryCurrent = beginOperation().current;
        await retry;
        return;
      }

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
        store.clearSelectedChange(projectId, "working");
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
      if (recoveryCurrent()) onError(recoveryError);
    }
  });

  const loadDiff = useMemoizedFn(async (
    path: string,
    kind: TerminalPreviewChangeKind,
    options?: { baseOid?: string; commitOid?: string },
  ): Promise<void> => {
    if (!projectId) return;
    const { current, selection } = beginOperation();
    try {
      await fetchDiff(path, kind, options);
    } catch (error) {
      if (!current()) return;
      const staleDiff = error instanceof HttpError && error.status === 409
        && (error.code === "terminal_preview_stale_diff" || (error.code === undefined && [
          "Change no longer exists; refresh the list",
          "Change moved; refresh the list",
          "Original version moved; refresh the list",
        ].includes(error.message)));
      const matchesSelection =
        kind === "branch"
          ? selection?.selectedBranchChangePath === path
          : kind === "commit"
            ? selection?.selectedCommitChangePath === path
            : selection?.selectedChangePath === path &&
              selection?.selectedChangeKind === kind;
      if (!staleDiff || !matchesSelection) {
        onError(error);
        return;
      }
      await recoverStaleDiff(path, kind);
    }
  });

  return { loadChanges, loadDiff, recoverStaleDiff };
}
